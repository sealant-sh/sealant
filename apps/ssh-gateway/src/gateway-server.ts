import type {
  AuthContext,
  Connection,
  PseudoTtyInfo,
  ServerChannel,
} from "ssh2";
import ssh2 from "ssh2";
const { Server } = ssh2;

import type { Channel } from "@sealant/runtime-client";

import { findAuthorizedKey, type AuthorizedKeyEntry } from "./authorized-keys.js";
import { ControlClient, type ShellSession, type ExecSession } from "./control-client.js";
import {
  parseSandboxIdFromUsername,
  resolveSandboxControlTarget,
  toControlTarget,
} from "./sandbox-target.js";

/*
Gateway architecture in one sentence (gateway-spec §3):
client SSH session <-> this process <-> sealantd *control connection* to the sandbox's control.sock.

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
  readonly sandboxUsernamePrefix: string;
  readonly coreApiBaseUrl: string;
  readonly gatewayToken: string;
}

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

/**
 * Bridge an SSH `ServerChannel` to a daemon byte `Channel`: inbound daemon bytes -> client channel,
 * client bytes -> `onClientData`. On the daemon channel's `End` we surface the process exit code to
 * the SSH channel and close it; on the client EOF we half-close the daemon channel.
 */
const bridgeChannel = (input: {
  readonly sshChannel: ServerChannel;
  readonly channel: Channel;
  readonly onClientData: (data: Uint8Array) => void;
  /** Whether to translate the daemon `End.exit_code` into an SSH `exit-status` (exec/shell only). */
  readonly relayExit: boolean;
}): void => {
  const { sshChannel, channel, onClientData, relayExit } = input;

  // Pump inbound daemon bytes -> SSH client.
  void (async () => {
    try {
      for await (const chunk of channel) {
        sshChannel.write(Buffer.from(chunk));
      }
    } catch {
      // Iteration ends on close; failures fall through to the `closed` handling below.
    }
  })();

  // The daemon channel closing is the authoritative end: relay exit status, then close the SSH side.
  void channel.closed.then((cause) => {
    if (relayExit && cause.kind === "remote") {
      const exitCode = cause.end.exitCode;
      if (typeof exitCode === "number") {
        sshChannel.exit(exitCode);
      } else if (typeof cause.end.signal === "number") {
        sshChannel.exit(exitCode ?? 1);
      }
    }
    sshChannel.end();
    return undefined;
  });

  // Client -> daemon. Forward bytes; on client EOF half-close the daemon channel.
  sshChannel.on("data", (data: Buffer) => {
    onClientData(new Uint8Array(data));
  });
  sshChannel.on("end", () => {
    if (!channel.isClosed) {
      channel.end();
    }
  });
  sshChannel.on("close", () => {
    if (!channel.isClosed) {
      channel.end();
    }
  });
};

// One incoming client connection maps to exactly one sandbox and one lazily-opened control
// connection. SSH channels are then mapped onto control commands across that connection.
const bindClientConnection = (incomingConnection: Connection, config: SshGatewayServerConfig) => {
  // The sandbox routing decision comes from the SSH username (sbx-<id>); the real per-sandbox gate is
  // the API, keyed by the authenticated principal. Both are set once auth passes.
  let sandboxId: string | undefined;
  let principalId: string | undefined;
  // A single client connection gets a single control connection. Channels multiplex over it.
  let controlPromise: Promise<ControlClient> | undefined;
  let controlClient: ControlClient | undefined;

  const ensureControl = async (): Promise<ControlClient> => {
    if (sandboxId === undefined || principalId === undefined) {
      throw new Error("Incoming SSH connection is not mapped to an authorized sandbox.");
    }

    if (controlPromise === undefined) {
      // Defer the control connection until the first channel request: no work for auth failures, and
      // the API authorizes principal x sandbox at resolve time (§3.4).
      const resolvedSandboxId = sandboxId;
      const resolvedPrincipalId = principalId;
      controlPromise = (async () => {
        const target = await resolveSandboxControlTarget({
          apiBaseUrl: config.coreApiBaseUrl,
          gatewayToken: config.gatewayToken,
          principalId: resolvedPrincipalId,
          sandboxId: resolvedSandboxId,
        });
        const client = ControlClient.open(toControlTarget(target));
        controlClient = client;
        return client;
      })();
    }

    return controlPromise;
  };

  incomingConnection.on("authentication", (ctx: AuthContext) => {
    // We only support public-key auth at the gateway boundary.
    if (ctx.method !== "publickey") {
      ctx.reject(["publickey"]);
      return;
    }

    const resolvedSandboxId = parseSandboxIdFromUsername(
      ctx.username,
      config.sandboxUsernamePrefix,
    );

    if (resolvedSandboxId === undefined) {
      ctx.reject();
      return;
    }

    const key = findAuthorizedKey(config.allowedClientKeys, {
      algo: ctx.key.algo,
      data: ctx.key.data,
    });

    if (key === undefined) {
      ctx.reject();
      return;
    }

    if (ctx.signature === undefined) {
      // OpenSSH may probe a key before sending a signed proof. Accepting here means
      // "this key is recognized", not "auth is complete".
      ctx.accept();
      return;
    }

    if (ctx.blob === undefined) {
      ctx.reject();
      return;
    }

    const hashAlgo = typeof ctx.hashAlgo === "string" ? ctx.hashAlgo : undefined;
    // Signature verification proves possession of the private key for an allowed pubkey.
    if (!key.verify(ctx.blob, ctx.signature, hashAlgo)) {
      ctx.reject();
      return;
    }

    // The username is only a routing hint now; the principal (key owner) is the authorization subject.
    sandboxId = resolvedSandboxId;
    principalId = key.principalId;
    ctx.accept();
  });

  incomingConnection.on("ready", () => {
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
        acceptEnv();
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
            const control = await ensureControl();
            // §3.3 shell + §3.5 login semantics: openSession{login} -> attachSession{Interactive}.
            const shell = await control.openShell({
              cols: sessionPty?.cols ?? 80,
              rows: sessionPty?.rows ?? 24,
              term: sessionEnv.TERM,
              env: sessionEnv,
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
              sandboxId,
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
            const control = await ensureControl();
            // §3.3 exec + §3.5 login: exec{/bin/bash -lc <cmd>, attach:true}; End.exit_code -> exit.
            const exec = await control.execLogin({
              command: info.command,
              env: sessionEnv,
            });
            activeExec = exec;
            bridgeChannel({
              sshChannel,
              channel: exec.channel,
              onClientData: (data) => {
                exec.channel.write(data);
              },
              relayExit: true,
            });
          } catch (error) {
            console.error("[ssh-gateway] exec session setup failed", {
              sandboxId,
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
            const control = await ensureControl();
            // §3.3 subsystem:sftp -> openSftp; bridge the subsystem channel <-> the byte channel.
            const { channel } = await control.openSftp();
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
              sandboxId,
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
          const control = await ensureControl();
          // §3.3 direct-tcpip -> openForward. This is the VS Code Remote-SSH server path: the editor
          // connects *through* the sandbox to host:port (openForward connects from inside the
          // container), not from the gateway host.
          const { channel } = await control.openForward(info.destIP, info.destPort);
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
      sandboxId,
    });
  });

  incomingConnection.on("close", () => {
    if (controlPromise === undefined) {
      return;
    }
    // Closing the control connection tears down every daemon channel it owns (§0.3).
    void controlPromise
      .then((control) => {
        control.close();
        return undefined;
      })
      .catch(() => undefined);
  });
};

// Start listening for incoming client SSH sessions.
export const startSshGatewayServer = (config: SshGatewayServerConfig) => {
  const server = new Server(
    {
      hostKeys: [config.hostKey],
      ...(config.banner === undefined ? {} : { banner: config.banner }),
    },
    (incomingConnection) => {
      bindClientConnection(incomingConnection, config);
    },
  );

  server.on("error", (error: Error) => {
    console.error("[ssh-gateway] server error", {
      error: error.message,
    });
  });

  return new Promise<{ stop: () => Promise<void> }>((resolve, reject) => {
    server.once("error", (error: Error) => {
      reject(error);
    });
    server.listen(config.port, config.host, () => {
      resolve({
        stop: async () => {
          await new Promise<void>((stopResolve, stopReject) => {
            server.close((error) => {
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
