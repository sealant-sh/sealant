import { createServer as createNetServer, type Socket } from "node:net";

import type { AuthContext, Connection, PseudoTtyInfo, ServerChannel } from "ssh2";
import ssh2 from "ssh2";
const { Server, utils } = ssh2;

import type { Channel } from "@sealant/runtime-client";
import { computeSshPublicKeyFingerprint } from "@sealant/validators/ssh-public-key";

import {
  createAdmission,
  DEFAULT_ADMISSION_LIMITS,
  type AdmissionLimits,
  type AdmissionTicket,
} from "./admission.js";
import {
  findAuthorizedKey,
  type AuthorizedKeyEntry,
  type VerifyFunction,
} from "./authorized-keys.js";
import {
  ControlClient,
  EXEC_USER_CAPABILITY,
  SFTP_USER_CAPABILITY,
  type ShellSession,
  type ExecSession,
} from "./control-client.js";
import type { PrincipalLookup } from "./principal-resolver.js";
import { finalizeInteractiveRun, startInteractiveRun } from "./run-recorder.js";
import {
  parseWorkspaceIdFromUsername,
  resolveWorkspaceControlTarget,
  toControlTarget,
  SshKeyNoLongerRegisteredError,
  type ControlTargetOptions,
  type WorkspaceSshTarget,
} from "./workspace-target.js";

/*
Gateway architecture in one sentence (gateway-spec §3):
client SSH session <-> this process <-> sealantd *control connection* to the workspace's control.sock.

The gateway is still an `ssh2.Server` toward the client (its own host key is the single known_hosts
the user sees, pubkey auth identifies a principal). But instead of dialing an inner sshd, it opens one
sealantd control connection per client connection (§2 transport) and maps each SSH channel to a
control command + a daemon byte channel (§3.3). When the client disconnects, closing the control
connection tears down every daemon channel it owned (§0.3).
*/

export interface SshGatewayServerConfig {
  readonly host: string;
  readonly port: number;
  readonly hostKey: string;
  readonly banner?: string;
  readonly allowedClientKeys: ReadonlyArray<AuthorizedKeyEntry>;
  readonly workspaceUsernamePrefix: string;
  readonly coreApiBaseUrl: string;
  readonly gatewayToken: string;
  /** Resolves an offered key to its owning principal via the API (DB-registered keys). */
  readonly lookupPrincipal: PrincipalLookup;
  /** How this gateway reaches each runtime family (client TLS for Kubernetes `wss://`). */
  readonly controlTargetOptions?: ControlTargetOptions;
  /** What a connection is held to before it logs in (`admission.ts`); sshd-like defaults. */
  readonly limits?: AdmissionLimits;
  /**
   * How often a logged-in connection asks again whether it is still authorized (its key still
   * registered, the workspace still its principal's), ending it when not. This is what ends a
   * connection that opens nothing new after its key is removed. 0 turns it off.
   */
  readonly keyRecheckIntervalMs?: number;
}

/** Default for `keyRecheckIntervalMs`. */
export const DEFAULT_KEY_RECHECK_INTERVAL_MS = 60_000;

/** A key accepted for auth: who it belongs to + how to verify a signature made with it. */
interface ResolvedClientKey {
  readonly principalId: string;
  readonly verify: VerifyFunction;
  /** The registered key's fingerprint; undefined for a key from the allowlist file. */
  readonly keyFingerprint: string | undefined;
}

/** Build a signature verifier for a DB-resolved key from the raw blob the client offered. */
const toOfferedKeyVerifier = (keyData: Buffer): VerifyFunction | undefined => {
  const parsed = utils.parseKey(keyData);

  if (parsed instanceof Error) {
    return undefined;
  }

  const key = Array.isArray(parsed) ? parsed[0] : parsed;

  if (key === undefined || typeof key !== "object" || !("verify" in key)) {
    return undefined;
  }

  return key.verify.bind(key) as VerifyFunction;
};

// POSIX signal names (as ssh2 delivers them, e.g. "INT") -> numbers the daemon's `signalProcess`
// expects. Covers the signals an interactive client realistically sends (Ctrl-C, Ctrl-\, kill, ...).
const SIGNAL_NUMBERS: Record<string, number> = {
  HUP: 1,
  INT: 2,
  QUIT: 3,
  ILL: 4,
  TRAP: 5,
  ABRT: 6,
  BUS: 7,
  FPE: 8,
  KILL: 9,
  USR1: 10,
  SEGV: 11,
  USR2: 12,
  PIPE: 13,
  ALRM: 14,
  TERM: 15,
  CONT: 18,
  STOP: 19,
  TSTP: 20,
};

// Reverse map (daemon `StreamEnd.signal` number -> POSIX name) so we can relay a process that died
// from a signal as a proper SSH `exit-signal` rather than collapsing it into a numeric exit-status.
const SIGNAL_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(SIGNAL_NUMBERS).map(([name, number]) => [number, name]),
);

/**
 * Bridge an SSH `ServerChannel` to a daemon byte `Channel`: inbound daemon bytes -> client channel,
 * client bytes -> `onClientData`.
 *
 * Teardown is asymmetric on purpose (SSH half-close semantics, gateway-spec §3.3):
 *   - The daemon channel's remote `End` is the authoritative end-of-stream. We relay the exit status
 *     (exec/shell) and then `end()` the SSH channel.
 *   - On client EOF (`end` event) we only HALF-close the daemon channel (`channel.end()`): the client
 *     has nothing more to send, but the daemon's remaining output + its `End`/exit status must still
 *     arrive. We do NOT full-close here — that would drop the tail of `ssh host cmd` output.
 *   - Only on the SSH channel fully closing (`close` event) do we `destroy()` the daemon channel, a
 *     real local teardown that releases it from the demux table.
 */
const bridgeChannel = (input: {
  readonly sshChannel: ServerChannel;
  readonly channel: Channel;
  readonly onClientData: (data: Uint8Array) => void;
  /** Client EOF beyond the channel half-close — exec paths close the process stdin here. */
  readonly onClientEof?: () => void;
  /** Whether to translate the daemon `End.exit_code`/`signal` into an SSH exit (exec/shell only). */
  readonly relayExit: boolean;
}): void => {
  const { sshChannel, channel, onClientData, onClientEof, relayExit } = input;

  // Pump inbound daemon bytes -> SSH client, THEN relay the exit/close. The ordering here is
  // load-bearing: the `for await` loop only completes after the channel iterator has yielded every
  // queued inbound chunk (the daemon's `StreamEnd` first drains `#inbound`, then ends the iterator).
  // Only once the last byte has been handed to `sshChannel.write` do we relay the exit status and
  // `end()` the SSH side. Doing the exit/`end()` off `channel.closed` instead RACES the pump: for a
  // short final payload (e.g. a 35-byte HTTP body) `closed` can resolve and close the SSH channel
  // before the trailing data chunk is flushed, truncating the response. (`channel.closed` resolving
  // does NOT imply inbound is drained — `#inbound` may still hold queued chunks.)
  void (async () => {
    try {
      for await (const chunk of channel) {
        sshChannel.write(Buffer.from(chunk));
      }
    } catch {
      // Iteration ends on close; the close cause is read from `channel.closeCause` below.
    }

    // The pump has drained: every inbound byte is now flushed to the SSH client. Read why the channel
    // closed (set by the iterator completing) and relay the exit status before closing the SSH side.
    const cause = channel.closeCause;
    if (relayExit && cause?.kind === "remote") {
      const { exitCode, signal } = cause.end;
      if (typeof signal === "number" && SIGNAL_NAMES[signal] !== undefined) {
        // Process died from a signal: relay a proper SSH `exit-signal`.
        sshChannel.exit(SIGNAL_NAMES[signal], false, cause.end.error ?? "");
      } else if (typeof exitCode === "number") {
        sshChannel.exit(exitCode);
      } else if (typeof signal === "number") {
        // Unknown signal number: fall back to a non-zero exit-status so the client sees failure.
        sshChannel.exit(1);
      }
    }
    sshChannel.end();
  })();

  // Client -> daemon. Forward bytes; the two teardown events map to the two close modes:
  sshChannel.on("data", (data: Buffer) => {
    onClientData(new Uint8Array(data));
  });
  // Client EOF: half-close outbound only. Inbound (daemon output + End/exit) keeps flowing.
  sshChannel.on("end", () => {
    onClientEof?.();
    if (!channel.isOutboundClosed) {
      channel.end();
    }
  });
  // SSH channel fully gone: full local teardown of the daemon channel.
  sshChannel.on("close", () => {
    if (!channel.isClosed) {
      channel.destroy();
    }
  });
};

// One incoming client connection maps to exactly one workspace and one lazily-opened control
// connection. SSH channels are then mapped onto control commands across that connection.
/** How long an ended connection's client has to close before its socket is destroyed. */
const END_TO_DESTROY_MS = 2_000;

const bindClientConnection = (
  incomingConnection: Connection,
  config: SshGatewayServerConfig,
  ticket: AdmissionTicket,
  socket: Socket,
) => {
  // The workspace routing decision comes from the SSH username (ws-<id>); the real per-workspace gate is
  // the API, keyed by the authenticated principal. Both are set once auth passes.
  let workspaceId: string | undefined;
  let principalId: string | undefined;
  // The registered key the connection logged in with; every later target answer checks it is
  // still the principal's. Undefined for a key from the allowlist file, which nothing removes.
  let keyFingerprint: string | undefined;
  let ended = false;
  let recheckTimer: ReturnType<typeof setInterval> | undefined;

  const endConnection = (reason: string) => {
    if (ended) return;
    ended = true;
    // Only a logged-in connection's end is worth a line: before login, anyone can cause one.
    if (principalId !== undefined) {
      console.warn("[ssh-gateway] ending a connection", { workspaceId, principalId, reason });
    }
    incomingConnection.end();
    // `end()` sends DISCONNECT and half-closes, and ssh2 goes on reading: a client that ignores the
    // DISCONNECT could keep writing into channels it already had open. The socket goes after a
    // moment either way.
    setTimeout(() => {
      socket.destroy();
    }, END_TO_DESTROY_MS).unref();
  };
  // A single client connection gets a single control connection. Channels multiplex over it.
  let controlPromise: Promise<ControlClient> | undefined;
  let controlClient: ControlClient | undefined;
  // The target the control connection was opened for: a later answer naming another executor
  // means the workspace restarted under this connection, and its channels are refused.
  let controlTarget: WorkspaceSshTarget | undefined;
  // Whether the daemon runs processes as a user, read once per connection when first needed.
  let daemonSupports: Promise<ReadonlySet<string>> | undefined;
  // The interactive run recording this connection (one SSH connection = one run). Undefined until
  // the first channel opens, and stays undefined when recording is unavailable (best-effort).
  let recordedRunId: string | undefined;
  let recordedRunOwner: string | undefined;

  /**
   * The workspace's target as the API answers it now. Unless `checkKey` is false (the gateway's own
   * capture as the connection closes), the answer comes only while the connection's key is still
   * registered; an outright refusal ends the connection, so nothing more opens on it.
   */
  const resolveTarget = async (
    options: { readonly checkKey: boolean } = { checkKey: true },
  ): Promise<WorkspaceSshTarget> => {
    if (workspaceId === undefined || principalId === undefined) {
      throw new Error("Incoming SSH connection is not mapped to an authorized workspace.");
    }
    try {
      return await resolveWorkspaceControlTarget({
        apiBaseUrl: config.coreApiBaseUrl,
        gatewayToken: config.gatewayToken,
        principalId,
        workspaceId,
        ...(options.checkKey && keyFingerprint !== undefined ? { keyFingerprint } : {}),
      });
    } catch (error) {
      if (options.checkKey && error instanceof SshKeyNoLongerRegisteredError) {
        endConnection(error.message);
      }
      throw error;
    }
  };
  const ensureControl = async (): Promise<ControlClient> => {
    if (workspaceId === undefined || principalId === undefined) {
      throw new Error("Incoming SSH connection is not mapped to an authorized workspace.");
    }

    if (controlPromise === undefined) {
      // Defer the control connection until the first channel request: no work for auth failures, and
      // the API authorizes principal x workspace at resolve time (§3.4).
      const resolvedWorkspaceId = workspaceId;
      const resolvedPrincipalId = principalId;
      controlPromise = (async () => {
        const target = await resolveTarget();
        controlTarget = target;
        // Register the session's run BEFORE any daemon channel opens so its id can be threaded as
        // the execution id on every session/exec — that threading is what attributes the session's
        // telemetry to this run. Undefined (recording unavailable) never blocks access.
        recordedRunId = await startInteractiveRun({
          config: { apiBaseUrl: config.coreApiBaseUrl, gatewayToken: config.gatewayToken },
          workspaceId: resolvedWorkspaceId,
          ownerUserId: resolvedPrincipalId,
        });
        recordedRunOwner = resolvedPrincipalId;
        const client = ControlClient.open(
          toControlTarget(target, config.controlTargetOptions ?? {}),
        );
        controlClient = client;
        return client;
      })();
    }

    return controlPromise;
  };

  /**
   * Who a new session channel (shell, exec, sftp) runs as, asked of the API for every channel, so
   * a change to the workspace's SSH user reaches the next channel of a connection already open (an
   * OpenSSH ControlMaster, VS Code's reused connection), never only the next connection. A user
   * goes only to a daemon that reports `exec.user` (an older one ignores `user` and would run the
   * process as root); sealantd itself refuses root and anyone who is not one of the executor's
   * people. Null: root, as the API stated it.
   */
  /**
   * The control connection, for a channel the API has just authorized: every channel, a port
   * forward's included, asks afresh, so an answer kept from opening the control connection never
   * stands in for a reset, a restart, a removed key or an API refusal.
   */
  const authorizedControl = async (
    options: { readonly checkKey: boolean } = { checkKey: true },
  ): Promise<{ readonly control: ControlClient; readonly target: WorkspaceSshTarget }> => {
    const control = await ensureControl();
    const target = await resolveTarget(options);
    if (
      controlTarget === undefined ||
      target.attemptId !== controlTarget.attemptId ||
      target.runtime.resourceId !== controlTarget.runtime.resourceId
    ) {
      throw new Error(
        `Workspace ${String(workspaceId)} started another executor since this connection opened: reconnect.`,
      );
    }
    return { control, target };
  };

  const sessionChannel = async (
    options: { readonly checkKey: boolean } = { checkKey: true },
  ): Promise<{
    readonly control: ControlClient;
    readonly user: string | null;
  }> => {
    const { control, target } = await authorizedControl(options);
    const user = target.sessionUser;
    if (user !== null) {
      daemonSupports ??= control.supports();
      if (!(await daemonSupports).has(EXEC_USER_CAPABILITY)) {
        throw new Error(
          `Workspace ${String(workspaceId)} runs its SSH sessions as a user, and its sealantd does not report ${EXEC_USER_CAPABILITY}.`,
        );
      }
    }
    return { control, user };
  };

  // OpenSSH sends every offered key twice (an unsigned probe, then a signed proof), so the API
  // lookup result is cached per connection to avoid a second round-trip. A key found unknown is
  // remembered too, so offering it again costs nothing. A removed key is caught after login by the
  // target check every channel makes.
  let cachedLookup: { readonly cacheKey: string; readonly principalId: string } | undefined;
  const unknownKeys = new Set<string>();

  // Resolution order: static file allowlist first (local, synchronous, works when the API is
  // down — the operator break-glass path), then the API lookup for DB-registered keys. A key in
  // both resolves to the file's principal; DB revocation cannot override a file entry by design.
  const resolveOfferedKeyPrincipal = async (offered: {
    readonly algo: string;
    readonly data: Buffer;
  }): Promise<ResolvedClientKey | undefined> => {
    const fileEntry = findAuthorizedKey(config.allowedClientKeys, offered);

    if (fileEntry !== undefined) {
      return {
        principalId: fileEntry.principalId,
        verify: fileEntry.verify,
        keyFingerprint: undefined,
      };
    }

    const cacheKey = `${offered.algo}:${offered.data.toString("base64")}`;
    if (unknownKeys.has(cacheKey)) {
      return undefined;
    }
    let resolvedPrincipalId =
      cachedLookup?.cacheKey === cacheKey ? cachedLookup.principalId : undefined;

    if (resolvedPrincipalId === undefined) {
      // Each lookup is spent from the source's budget before the API is asked: one address cannot
      // spend what everyone else's logins need.
      if (!ticket.takeKeyLookup()) {
        endConnection("its source spent its key lookups");
        return undefined;
      }
      const lookup = await config.lookupPrincipal({ algo: offered.algo, data: offered.data });

      if (lookup.kind === "error") {
        // Lookup failure is NOT "unknown key": log loudly (fingerprint only — never key material)
        // and reject this attempt rather than silently degrading auth semantics.
        console.error("[ssh-gateway] principal lookup failed", {
          fingerprint: computeSshPublicKeyFingerprint(offered.data),
          error: lookup.message,
        });
        return undefined;
      }

      if (lookup.kind === "not-found") {
        unknownKeys.add(cacheKey);
        return undefined;
      }

      // A registered key costs its source nothing: the budget is for keys nobody holds, so a busy
      // office or CGNAT address that logs in often keeps it (sshd's PerSourcePenalties charges
      // failures alone). Every channel re-checks the key, so the refund admits nothing more.
      ticket.refundKeyLookup();
      resolvedPrincipalId = lookup.principalId;
      cachedLookup = { cacheKey, principalId: resolvedPrincipalId };
    }

    // The API matched this exact blob's fingerprint, so verifying signatures against the offered
    // key is sound: the signature proves possession, the DB proves the blob -> principal binding.
    const verify = toOfferedKeyVerifier(offered.data);

    if (verify === undefined) {
      return undefined;
    }

    return {
      principalId: resolvedPrincipalId,
      verify,
      keyFingerprint: computeSshPublicKeyFingerprint(offered.data),
    };
  };

  /** Refuses one attempt; the connection ends once it has made all it may (sshd MaxAuthTries). */
  const refuse = (ctx: AuthContext, methods?: Array<"publickey">) => {
    if (methods === undefined) {
      ctx.reject();
    } else {
      ctx.reject(methods);
    }
    // OpenSSH opens with method `none` to learn the methods; sshd does not count it either.
    if (ctx.method !== "none" && ticket.refusedAttempt()) {
      endConnection("too many authentication attempts");
    }
  };

  const handleAuthentication = async (ctx: AuthContext): Promise<void> => {
    // An ended connection still reads what the client sent before it learned: none of it is
    // looked up.
    if (ended) {
      return;
    }

    // We only support public-key auth at the gateway boundary.
    if (ctx.method !== "publickey") {
      refuse(ctx, ["publickey"]);
      return;
    }

    const resolvedWorkspaceId = parseWorkspaceIdFromUsername(
      ctx.username,
      config.workspaceUsernamePrefix,
    );

    if (resolvedWorkspaceId === undefined) {
      refuse(ctx);
      return;
    }

    // Runs in the probe phase too: rejecting an unknown key at probe is how clients move on to
    // their next identity instead of burning a signed attempt on a doomed key.
    const key = await resolveOfferedKeyPrincipal({
      algo: ctx.key.algo,
      data: ctx.key.data,
    });

    if (ended) {
      // Its source spent its key lookups: the connection is already gone.
      return;
    }

    if (key === undefined) {
      refuse(ctx);
      return;
    }

    if (ctx.signature === undefined) {
      // OpenSSH may probe a key before sending a signed proof. Accepting here means
      // "this key is recognized", not "auth is complete".
      ctx.accept();
      return;
    }

    if (ctx.blob === undefined) {
      refuse(ctx);
      return;
    }

    const hashAlgo = typeof ctx.hashAlgo === "string" ? ctx.hashAlgo : undefined;
    // Signature verification proves possession of the private key for an allowed pubkey.
    if (!key.verify(ctx.blob, ctx.signature, hashAlgo)) {
      refuse(ctx);
      return;
    }

    // The username is only a routing hint now; the principal (key owner) is the authorization subject.
    workspaceId = resolvedWorkspaceId;
    principalId = key.principalId;
    keyFingerprint = key.keyFingerprint;
    ctx.accept();
  };

  incomingConnection.on("authentication", (ctx: AuthContext) => {
    // The handler awaits the API lookup, so it settles the ctx asynchronously; ssh2 blocks the
    // client on SSH_MSG_USERAUTH_* until then. The catch is the single-settle safety net — if the
    // handler throws after partial progress (or the connection died mid-await), force a reject.
    void handleAuthentication(ctx).catch(() => {
      try {
        ctx.reject();
      } catch {
        // Connection already torn down.
      }
    });
  });

  incomingConnection.on("ready", () => {
    ticket.loggedIn();
    const recheckMs = config.keyRecheckIntervalMs ?? DEFAULT_KEY_RECHECK_INTERVAL_MS;
    if (recheckMs > 0) {
      // A connection that opens nothing new is still asked about: a refusal (a removed key) ends
      // it. Any other failure (the API down, the workspace stopping) is left to what it ends.
      recheckTimer = setInterval(() => {
        void resolveTarget().catch(() => undefined);
      }, recheckMs);
      recheckTimer.unref();
    }

    incomingConnection.on("session", (acceptSession) => {
      const session = acceptSession();
      // Request metadata from the client we must replay onto the control session.
      let sessionPty: PseudoTtyInfo | undefined;
      const sessionEnv: Record<string, string> = {};
      // The active shell session (for resize/signal) once a shell channel is open.
      let activeShell: ShellSession | undefined;
      // The active exec session (for signal) once an exec channel is open.
      let activeExec: ExecSession | undefined;

      session.on("pty", (acceptPty, _rejectPty, info) => {
        // Client asked for a terminal. Remember dimensions/term for openSession.
        sessionPty = info;
        acceptPty();
      });

      session.on("env", (acceptEnv, _rejectEnv, info) => {
        // Accumulate client-requested env (e.g. TERM) for openSession/exec.
        sessionEnv[info.key] = info.val;
        // OpenSSH sends env requests with want_reply=0 (e.g. `SendEnv LANG`), so ssh2 passes no
        // accept callback. Calling it unconditionally throws and tears down the whole connection.
        acceptEnv?.();
      });

      session.on("window-change", (acceptWindowChange, _rejectWindowChange, info) => {
        // Keep terminal resize events flowing to the daemon PTY (§3.3 window-change -> resizePty).
        if (activeShell !== undefined && controlClient !== undefined) {
          void controlClient.resizePty(activeShell.sessionId, info.cols, info.rows).catch(() => {});
        }
        acceptWindowChange?.();
      });

      session.on("signal", (acceptSignal, _rejectSignal, info) => {
        // Forward signals (e.g. Ctrl-C) to the session/exec leader (§3.3 signal -> signalProcess).
        const signalName = info.name.replace(/^SIG/, "");
        const signalNumber = SIGNAL_NUMBERS[signalName];
        const processId = activeShell?.processId ?? activeExec?.processId;
        if (signalNumber !== undefined && processId !== undefined && controlClient !== undefined) {
          void controlClient.signalProcess(processId, signalNumber).catch(() => {});
        }
        acceptSignal?.();
      });

      session.on("shell", (acceptChannel, rejectChannel) => {
        const sshChannel = acceptChannel();
        if (sshChannel === undefined) {
          rejectChannel();
          return;
        }

        void (async () => {
          try {
            const { control, user } = await sessionChannel();
            const sessionUser = user ?? undefined;
            if (sessionPty === undefined) {
              // No pty-req before the shell request: the client is a PROGRAM driving a shell
              // over stdin — `ssh -T` (VS Code Remote-SSH's server bootstrap), `ssh host <
              // script`. A PTY here echoes the client's own input back and interleaves
              // prompts and instrumentation into the stream, corrupting any protocol run
              // over it (Remote-SSH sees its echoed marker strings as protocol messages).
              // Honor no-pty: a plain stdin-driven login shell over the byte-clean exec
              // path — no echo, no prompts, no terminal.
              const exec = await control.execLogin({
                command: 'exec "${SHELL:-/bin/sh}"',
                env: sessionEnv,
                executionId: recordedRunId,
                user: sessionUser,
              });
              activeExec = exec;
              bridgeChannel({
                sshChannel,
                channel: exec.channel,
                // Stdin travels as writeStdin control requests: the exec-attach channel is
                // output-only (the daemon registers no inbound sink — bytes written to it drop).
                onClientData: (data) => {
                  void control.writeProcessStdin(exec.processId, data).catch(() => {});
                },
                onClientEof: () => {
                  void control.closeProcessStdin(exec.processId);
                },
                relayExit: true,
              });
              return;
            }
            // §3.3 shell + §3.5 login semantics: openSession{login} -> attachSession{Interactive}.
            const shell = await control.openShell({
              cols: sessionPty.cols,
              rows: sessionPty.rows,
              term: sessionEnv.TERM,
              env: sessionEnv,
              executionId: recordedRunId,
              user: sessionUser,
            });
            activeShell = shell;
            bridgeChannel({
              sshChannel,
              channel: shell.channel,
              onClientData: (data) => {
                void control.writeSessionInput(shell.sessionId, data).catch(() => {});
              },
              relayExit: true,
            });
          } catch (error) {
            console.error("[ssh-gateway] shell session setup failed", {
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
            sshChannel.exit(1);
            sshChannel.end();
          }
        })();
      });

      session.on("exec", (acceptChannel, rejectChannel, info) => {
        const sshChannel = acceptChannel();
        if (sshChannel === undefined) {
          rejectChannel();
          return;
        }

        void (async () => {
          try {
            const { control, user } = await sessionChannel();
            const sessionUser = user ?? undefined;
            // §3.3 exec + §3.5 login: exec{/bin/bash -lc <cmd>, attach:true}; End.exit_code -> exit.
            const exec = await control.execLogin({
              command: info.command,
              env: sessionEnv,
              executionId: recordedRunId,
              user: sessionUser,
            });
            activeExec = exec;
            bridgeChannel({
              sshChannel,
              channel: exec.channel,
              // Stdin travels as writeStdin control requests: the exec-attach channel is
              // output-only (the daemon registers no inbound sink — bytes written to it drop).
              onClientData: (data) => {
                void control.writeProcessStdin(exec.processId, data).catch(() => {});
              },
              onClientEof: () => {
                void control.closeProcessStdin(exec.processId);
              },
              relayExit: true,
            });
          } catch (error) {
            console.error("[ssh-gateway] exec session setup failed", {
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
            sshChannel.exit(1);
            sshChannel.end();
          }
        })();
      });

      session.on("subsystem", (acceptChannel, rejectChannel, info) => {
        if (info.name !== "sftp") {
          // Parity with prior behavior: only sftp is bridged; other subsystems are rejected.
          rejectChannel();
          return;
        }

        const sshChannel = acceptChannel();
        if (sshChannel === undefined) {
          rejectChannel();
          return;
        }

        void (async () => {
          try {
            const { control, user } = await sessionChannel();
            if (user !== null) {
              // An older sealantd ignores `user` on `openSftp` and would write as root: SFTP runs
              // as the workspace's user only on one that reports it does, and is refused elsewhere.
              daemonSupports ??= control.supports();
              if (!(await daemonSupports).has(SFTP_USER_CAPABILITY)) {
                sshChannel.stderr.write(
                  "SFTP is not available in this workspace: it runs its sessions as your user, and its sealantd runs SFTP only as root. Use ssh to copy files (ssh host 'cat > file' < file).\n",
                );
                sshChannel.exit(1);
                sshChannel.end();
                return;
              }
            }
            // §3.3 subsystem:sftp -> openSftp; bridge the subsystem channel <-> the byte channel.
            const { channel } = await control.openSftp({
              ...(recordedRunId === undefined ? {} : { executionId: recordedRunId }),
              ...(user === null ? {} : { user }),
            });
            bridgeChannel({
              sshChannel,
              channel,
              onClientData: (data) => {
                channel.write(data);
              },
              relayExit: false,
            });
          } catch (error) {
            console.error("[ssh-gateway] sftp subsystem setup failed", {
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
            sshChannel.end();
          }
        })();
      });
    });

    incomingConnection.on("tcpip", (acceptChannel, rejectChannel, info) => {
      void (async () => {
        try {
          // A forward is a channel like any other: authorized afresh, never on an earlier answer.
          const { control } = await authorizedControl();
          // §3.3 direct-tcpip -> openForward. This is the VS Code Remote-SSH server path: the editor
          // connects *through* the workspace to host:port (openForward connects from inside the
          // container), not from the gateway host.
          const { channel } = await control.openForward(info.destIP, info.destPort, recordedRunId);
          const sshChannel = acceptChannel();
          if (sshChannel === undefined) {
            channel.end();
            return;
          }
          bridgeChannel({
            sshChannel,
            channel,
            onClientData: (data) => {
              channel.write(data);
            },
            relayExit: false,
          });
        } catch {
          // Connect failure (or unauthorized) -> deny this forwarded TCP request.
          rejectChannel();
        }
      })();
    });
  });

  incomingConnection.on("error", (error) => {
    console.error("[ssh-gateway] incoming connection error", {
      error: error.message,
      workspaceId,
    });
  });

  incomingConnection.on("close", () => {
    ticket.closed();
    if (recheckTimer !== undefined) {
      clearInterval(recheckTimer);
    }
    if (controlPromise === undefined) {
      return;
    }
    // Finalize the run over the still-open control connection (diff capture is best-effort), THEN
    // close it — closing tears down every daemon channel it owns (§0.3).
    void controlPromise
      .then(async (control) => {
        if (recordedRunId !== undefined && recordedRunOwner !== undefined) {
          // The working-tree capture is a login shell in the person's repository: it runs as the
          // workspace's user now, never root (git's configured helpers and filters run in it). When
          // who that is cannot be read, nothing is captured.
          // The gateway's own capture of what was done, not the client's request: it runs even when
          // the connection ended because its key was removed.
          const user = await sessionChannel({ checkKey: false }).then(
            (channel) => channel.user,
            () => undefined,
          );
          await finalizeInteractiveRun({
            config: { apiBaseUrl: config.coreApiBaseUrl, gatewayToken: config.gatewayToken },
            runId: recordedRunId,
            ownerUserId: recordedRunOwner,
            captureOutput:
              user === undefined
                ? undefined
                : async (command: string, cwd: string) => {
                    const result = await control.execCapture({
                      command,
                      cwd,
                      ...(user === null ? {} : { user }),
                    });
                    return { output: result.output, exitCode: result.exitCode };
                  },
          });
        }
        control.close();
        return undefined;
      })
      .catch(() => undefined);
  });
};

/** One TCP connection, as both the listener and ssh2's connection report name it. */
const socketKey = (address: string | undefined, port: number | undefined) =>
  `${String(address)}|${String(port)}`;

// Start listening for incoming client SSH sessions. The gateway owns the TCP listener and hands
// ssh2 only the connections it admits (`admission.ts`): a connection over a limit is dropped as it
// arrives, before any SSH is spoken, and one that has not logged in by its grace time is dropped.
export const startSshGatewayServer = (config: SshGatewayServerConfig) => {
  const admission = createAdmission(config.limits ?? DEFAULT_ADMISSION_LIMITS);
  // Accepted sockets by remote address and port, until ssh2 reports the connection they carry.
  const pending = new Map<string, { readonly socket: Socket; readonly ticket: AdmissionTicket }>();

  const server = new Server(
    {
      hostKeys: [config.hostKey],
      ...(config.banner === undefined ? {} : { banner: config.banner }),
    },
    (incomingConnection, info) => {
      const key = socketKey(info.ip, info.port);
      const admitted = pending.get(key);
      pending.delete(key);
      if (admitted === undefined) {
        // Every socket ssh2 sees came through the listener below; this one did not.
        incomingConnection.end();
        return;
      }
      bindClientConnection(incomingConnection, config, admitted.ticket, admitted.socket);
    },
  );

  server.on("error", (error: Error) => {
    console.error("[ssh-gateway] server error", {
      error: error.message,
    });
  });

  const listener = createNetServer((socket) => {
    const decision = admission.admit(socket.remoteAddress, () => {
      socket.destroy();
    });
    if (decision.kind === "refused") {
      socket.destroy();
      return;
    }
    const key = socketKey(socket.remoteAddress, socket.remotePort);
    pending.set(key, { socket, ticket: decision.ticket });
    socket.once("close", () => {
      pending.delete(key);
      decision.ticket.closed();
    });
    server.injectSocket(socket);
  });
  const sweeper = setInterval(() => {
    admission.sweep();
  }, 60_000);
  sweeper.unref();

  return new Promise<{ stop: () => Promise<void> }>((resolve, reject) => {
    listener.once("error", (error: Error) => {
      clearInterval(sweeper);
      reject(error);
    });
    listener.listen(config.port, config.host, () => {
      listener.on("error", (error: Error) => {
        console.error("[ssh-gateway] listener error", { error: error.message });
      });
      resolve({
        stop: async () => {
          clearInterval(sweeper);
          await new Promise<void>((stopResolve, stopReject) => {
            listener.close((error) => {
              if (error !== undefined) {
                stopReject(error);
                return;
              }

              stopResolve();
            });
          });
        },
      });
    });
  });
};
