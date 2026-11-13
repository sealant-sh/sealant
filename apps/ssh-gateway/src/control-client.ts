import type { Duplex } from "node:stream";

import { SealantClient } from "@sealant/runtime-client";
import type { Channel } from "@sealant/runtime-client";
import {
  AttachMode,
  type CommandResult,
  type StreamAttached,
  type ForwardOpened,
  type SftpOpened,
} from "@sealant/runtime-protocol";
import {
  openControlTransport,
  type ControlTransport,
  type SealantTarget,
} from "@sealant/workspaces";

/*
Control client + channel-mux glue (gateway-spec §3.1).

This wraps the `@sealant/runtime-client` SDK (the request/response + channel demux machinery) and the
§2 transport into the single object the gateway drives. Each client SSH connection gets one
`ControlClient`; SSH channels on that connection map to control commands and daemon byte channels
(`Channel`) over the one shared control connection. When the SSH connection closes we `close()` this
client, which drops the control connection and tears down every daemon channel it owned (§0.3).

The SDK exposes typed openers for the channel commands (attachSession / openForward / openSftp /
execAttached). The PTY *session* lifecycle commands (openSession / resizePty / closeSession) have no
typed SDK wrapper yet, so we drive them through the SDK's low-level `request()` with the generated
`Command` oneof — still fully typed against the protobuf surface.
*/

/** Login-shell semantics (gateway-spec §3.5): reproduce the inner sshd's `login -l` / `login -lc`. */
const LOGIN_SHELL = "/bin/bash";

/** The capability a daemon names when it starts executions and sessions as a user. */
export const EXEC_USER_CAPABILITY = "exec.user";

/** The capability a daemon names when it runs an SFTP bridge as a user (sealantd#155). */
export const SFTP_USER_CAPABILITY = "sftp.user";

/** A PTY interactive session bound to a daemon byte channel, ready to bridge to an SSH shell channel. */
export interface ShellSession {
  /** Daemon session id (for `resizePty` / `closeSession` / input via `writeStdin`). */
  readonly sessionId: string;
  /** Daemon process id of the session leader (for `signalProcess`). */
  readonly processId: string;
  /** The byte channel carrying PTY output inbound and accepting PTY input outbound. */
  readonly channel: Channel;
}

/** A login-shell `exec` bound to a daemon byte channel, ready to bridge to an SSH exec channel. */
export interface ExecSession {
  /** Daemon process id (for `signalProcess`). */
  readonly processId: string;
  /** The byte channel carrying stdout/stderr inbound and accepting stdin outbound. */
  readonly channel: Channel;
}

/** Convert an SSH env record into the daemon's repeated `EnvVar`. */
const toEnvVars = (env: Record<string, string>): Array<{ key: string; value: string }> =>
  Object.entries(env).map(([key, value]) => ({ key, value }));

/** A control command answered with a result other than the one it asked for. */
const unexpectedResult = (expected: string, result: CommandResult["result"]): Error =>
  new Error(`expected result ${expected}, got ${String(result.case)}`);

/**
 * One control connection to a single sealantd instance, driven over the §2 transport. Owns the
 * transport teardown and, via the SDK, every byte channel opened on it.
 */
export class ControlClient {
  readonly #transport: ControlTransport;
  readonly #client: SealantClient;

  private constructor(transport: ControlTransport, client: SealantClient) {
    this.#transport = transport;
    this.#client = client;
  }

  /** Open the transport for `target` and build a control client over its framed stream. */
  static open(target: SealantTarget): ControlClient {
    const transport = openControlTransport(target);
    const client = SealantClient.fromStream(transport.stream);
    return new ControlClient(transport, client);
  }

  /**
   * Build a control client over a pre-existing framed Duplex (test seam / future transports). The
   * `close` finalizer just destroys the stream; callers own its lifecycle.
   */
  static fromStream(stream: Duplex): ControlClient {
    const transport: ControlTransport = {
      stream,
      close: () => {
        stream.destroy();
      },
    };
    const client = SealantClient.fromStream(transport.stream);
    return new ControlClient(transport, client);
  }

  /** Probe the control channel (used by tests / readiness checks). */
  async health(): Promise<void> {
    await this.#client.health();
  }

  /** What the daemon names beyond the schema (`exec.user`, ...): read once per connection. */
  async supports(): Promise<ReadonlySet<string>> {
    const capabilities = await this.#client.getCapabilities();
    return new Set(capabilities.supports);
  }

  /**
   * Open a login interactive PTY session and attach to its output as a byte channel (§3.3 shell,
   * §3.5 login semantics). `openSession{shell:/bin/bash, args:["-l"]}` reproduces `login -l`.
   */
  async openShell(input: {
    readonly cols: number;
    readonly rows: number;
    readonly term?: string | undefined;
    readonly env: Record<string, string>;
    readonly cwd?: string | undefined;
    /** Run id threaded as the daemon execution id so this session's events attribute to it. */
    readonly executionId?: string | undefined;
    /** The Linux user the session runs as (a daemon that names `exec.user`); absent: root. */
    readonly user?: string | undefined;
  }): Promise<ShellSession> {
    const result = await this.#request({
      case: "openSession",
      value: {
        executionId: input.executionId,
        user: input.user,
        shell: LOGIN_SHELL,
        args: ["-l"],
        cols: input.cols,
        rows: input.rows,
        term: input.term,
        cwd: input.cwd,
        env: toEnvVars(input.env),
      },
    });
    if (result.case !== "sessionOpened") throw unexpectedResult("sessionOpened", result);
    const opened = result.value;

    const { channel } = await this.#attachSession(opened.sessionId);
    return { sessionId: opened.sessionId, processId: opened.processId, channel };
  }

  /**
   * Run a command as a login shell with its stdio bound to a byte channel (§3.3 exec, §3.5).
   * `exec{/bin/bash, ["-lc", command], attach:true}` reproduces `login -lc "$cmd"`. Driven through
   * the low-level request (not the SDK's `execAttached`) so client-requested `env` is threaded.
   */
  async execLogin(input: {
    readonly command: string;
    readonly env: Record<string, string>;
    readonly cwd?: string;
    /** Run id threaded as the daemon execution id so this exec's events attribute to it. */
    readonly executionId?: string | undefined;
    /** The Linux user the command runs as (a daemon that names `exec.user`); absent: root. */
    readonly user?: string | undefined;
  }): Promise<ExecSession> {
    const result = await this.#request({
      case: "exec",
      value: {
        executionId: input.executionId,
        user: input.user,
        executable: LOGIN_SHELL,
        args: ["-lc", input.command],
        cwd: input.cwd,
        env: toEnvVars(input.env),
        stdin: true,
        attach: true,
      },
    });
    if (result.case !== "processAttached") throw unexpectedResult("processAttached", result);
    const attached = result.value;

    const channel = this.#client.openChannel(attached.channelId);
    return { processId: attached.processId, channel };
  }

  /**
   * Run a command to completion and collect its combined output (finalize-path helper, e.g. the
   * end-of-session diff capture). Deliberately does NOT thread an execution id: the capture is
   * gateway bookkeeping, not something the user did — it must not appear in the session's record.
   */
  async execCapture(input: {
    readonly command: string;
    readonly cwd?: string;
    readonly timeoutMs?: number;
    /** The workspace's SSH user, whose repository this reads: the capture runs as them. */
    readonly user?: string;
  }): Promise<{ readonly exitCode: number | undefined; readonly output: string }> {
    const exec = await this.execLogin({
      command: input.command,
      env: {},
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.user === undefined ? {} : { user: input.user }),
    });
    const chunks: Buffer[] = [];
    const collect = (async () => {
      try {
        for await (const chunk of exec.channel) {
          chunks.push(Buffer.from(chunk));
        }
      } catch {
        // Iteration ends on close; exit is read from closeCause below.
      }
      const cause = exec.channel.closeCause;
      const exitCode = cause?.kind === "remote" ? (cause.end.exitCode ?? undefined) : undefined;
      return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
    })();

    const timeoutMs = input.timeoutMs ?? 10_000;
    return Promise.race([
      collect,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          exec.channel.destroy();
          reject(new Error(`execCapture timed out after ${timeoutMs}ms`));
        }, timeoutMs).unref();
      }),
    ]);
  }

  /**
   * Write stdin bytes to a non-PTY attached process (§1.A exec-attach input path). The
   * exec-attach CHANNEL is output-only — the daemon registers no inbound sink for it, so bytes
   * written to the channel vanish; stdin travels as `writeStdin{processId}` control requests.
   */
  async writeProcessStdin(processId: string, data: Uint8Array): Promise<void> {
    await this.#client.writeStdin({ processId }, data);
  }

  /** Half-close a non-PTY process's stdin — the client's EOF (`ssh host cmd < file`). */
  async closeProcessStdin(processId: string): Promise<void> {
    try {
      await this.#client.request({ case: "closeStdin", value: { processId } });
    } catch {
      // Best-effort EOF: the process may already have exited.
    }
  }

  /** Write client keystrokes / stdin bytes to a session's PTY (§3.3 shell input path). */
  async writeSessionInput(sessionId: string, data: Uint8Array): Promise<void> {
    // Route to the daemon's PTY input path keyed by session id (`writeStdin{sessionId}`). The bare
    // `writeStdin(string, ...)` form targets a *processId* — wrong for interactive sessions — so use
    // the session-targeted SDK helper.
    await this.#client.writeSessionInput(sessionId, data);
  }

  /** Resize a session's PTY (§3.3 window-change -> resizePty). */
  async resizePty(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.#request({ case: "resizePty", value: { sessionId, cols, rows } });
  }

  /** Deliver a signal to a process/session leader (§3.3 signal -> signalProcess). */
  async signalProcess(processId: string, signal: number): Promise<void> {
    await this.#client.signalProcess(processId, signal);
  }

  /** Close a session (best-effort; teardown also happens when the control connection drops). */
  async closeSession(sessionId: string): Promise<void> {
    await this.#request({ case: "closeSession", value: { sessionId } });
  }

  /** Open a direct-TCP forward to `host:port` as a byte channel (§3.3 direct-tcpip -> openForward). */
  async openForward(
    host: string,
    port: number,
    executionId?: string,
  ): Promise<{ result: ForwardOpened; channel: Channel }> {
    return this.#client.openForward({
      host,
      port,
      protocol: "tcp",
      ...(executionId === undefined ? {} : { executionId }),
    });
  }

  /** Open an SFTP subsystem byte channel (§3.3 subsystem:sftp -> openSftp). */
  async openSftp(options?: {
    readonly cwd?: string;
    readonly executionId?: string;
    /** The Linux user the sftp-server runs as (a daemon that names `sftp.user`); absent: root. */
    readonly user?: string;
  }): Promise<{ result: SftpOpened; channel: Channel }> {
    return this.#client.openSftp({
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options?.executionId === undefined ? {} : { executionId: options.executionId }),
      ...(options?.user === undefined ? {} : { user: options.user }),
    });
  }

  /** Close the control connection and, transitively, every daemon channel it owns (§0.3). */
  close(): void {
    this.#client.close();
    this.#transport.close();
  }

  /** Attach (interactive) to a session id and return its byte channel. */
  async #attachSession(sessionId: string): Promise<{ result: StreamAttached; channel: Channel }> {
    return this.#client.attachSession(sessionId, AttachMode.INTERACTIVE);
  }

  /**
   * Drive a non-channel command via the SDK's low-level `request()` and return its result, for the
   * caller to narrow by case. Errors surface as the SDK's `SealantError`.
   */
  async #request(
    command: Parameters<SealantClient["request"]>[0],
  ): Promise<CommandResult["result"]> {
    const response = await this.#client.request(command);
    const outcome = response.outcome?.outcome;
    if (outcome?.case === "error") {
      const error = outcome.value;
      throw new Error(error.message || `control error (${String(error.code)})`);
    }
    if (outcome?.case !== "ok") {
      throw new Error("control response had no outcome");
    }
    return outcome.value.result;
  }
}
