/**
 * The Sealant SDK public type surface.
 *
 * This is the fluent object model the marketing site commits to verbatim:
 *
 *   const workspace = await sealant.workspaces.create({ repository, harness: opencode() })
 *   const run = await workspace.harness.run("Round invoice totals once, after applying the discount.")
 *   await run.record.replay()
 *
 * Design rule (load-bearing): these public types are HAND-WRITTEN and DECOUPLED from the Effect-core
 * and `@sealant/telemetry` internal shapes. The facade maps internal data onto these types so the
 * public surface stays stable across Effect-v4-beta churn and internal read-model changes. The whole
 * surface is typed NOW — including operations not yet implemented in the current slice — so callers
 * compile against a stable contract from day one (unimplemented paths reject with
 * `SealantNotImplementedError` at runtime, see `./errors.js`).
 */

// ---------------------------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------------------------

/**
 * Public client configuration. Intentionally minimal: a base URL and an API key. Host-local
 * concerns required by the current slice (owner identity, registry, direct database access) live in
 * a separate internal config and never leak into this published type — see `./internal-config.ts`
 * when the Effect core lands.
 */
export interface SealantConfig {
  /** Base URL of the Sealant control-plane API (e.g. `http://localhost:8080`). */
  readonly baseUrl: string;
  /** Bearer token for authenticated deployments. Optional for a localhost demo with no auth. */
  readonly apiKey?: string;
  /** Override the `fetch` implementation (tests, custom agents, proxies). */
  readonly fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------------------------

/** The harnesses with first-class integrations baked into the platform today. */
export type HarnessId = "opencode" | "codex" | "claude-code";

/** A single one-shot command to invoke a harness against a prompt inside the workspace. */
export interface HarnessRunCommand {
  /** The executable to run (e.g. `"opencode"`). */
  readonly executable: string;
  /** Arguments, including the prompt where the harness expects it. */
  readonly args: readonly string[];
}

/**
 * A harness is a thin client value: an identity plus the knowledge of how to invoke it one-shot
 * against a prompt. `opencode()`, `codex()`, `claudeCode()` and `customHarness()` (see `./harness.js`)
 * produce these. Invoke-knowledge starts SDK-side as `buildRunCommand`; it migrates server-side into
 * the platform's harness integration in a later phase so every surface shares one source of truth.
 */
export interface Harness {
  /** Stable id. Built-in harnesses use a `HarnessId`; custom harnesses carry their own string. */
  readonly id: string;
  /** Builds the one-shot invocation for a prompt. */
  readonly buildRunCommand: (prompt: string) => HarnessRunCommand;
  /** Optional install hints for custom harnesses (built-ins are resolved by the platform). */
  readonly install?: {
    readonly packages?: readonly string[];
    readonly command?: string;
  };
  /** Optional launch command for an interactive session (defaults to the executable). */
  readonly launchCommand?: string;
}

// ---------------------------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------------------------

/** Lifecycle status of a workspace. */
export type WorkspaceStatus = "queued" | "running" | "ready" | "failed" | "cancelled" | "stopped";

/** A coarse lifecycle event observed while a workspace is being provisioned. */
export interface WorkspaceEvent {
  readonly type: string;
  readonly occurredAt: string;
  readonly message?: string;
}

/** The supported workspace OS families (maps to the blueprint target). */
export type WorkspaceOs = "fedora" | "arch" | "nix";

/**
 * Connected-account credentials to attach to a workspace at creation time, per provider — so the
 * harness inside the workspace authenticates as the caller's own Claude / Codex / GitHub identity
 * instead of running unauthenticated.
 *
 * For each provider: `true` means "my default account" (the one named `"default"`), and a `string`
 * names a specific connected account. `profile` names a profile slug/id whose bundled per-provider
 * bindings apply first; any explicit `claude`/`codex`/`github` field wins over the profile's binding
 * for that provider.
 *
 * SECURITY: only account **references** (booleans/names/ids) ever cross this surface — token values,
 * `auth.json` contents, and any other secret material never do. The control plane resolves references
 * to encrypted credentials server-side and injects them at launch.
 */
export interface WorkspaceCredentialsOptions {
  /** Profile id whose per-provider account bindings apply first. */
  readonly profile?: string;
  /** `true` for the caller's default Claude account, or a string naming a specific one. */
  readonly claude?: boolean | string;
  /** `true` for the caller's default Codex account, or a string naming a specific one. */
  readonly codex?: boolean | string;
  /** `true` for the caller's default GitHub account, or a string naming a specific one. */
  readonly github?: boolean | string;
}

/**
 * A workspace sourced from a CALLER-OWNED host directory instead of a fresh clone. The platform
 * bind-mounts `path` as the workspace working directory and treats it as caller-owned: writes
 * persist across workspace stop/restart/expiry, and the path is never reprovisioned or deleted.
 * When `path` is a linked Git worktree, the SDK also binds its shared Git metadata at the absolute
 * path named by the worktree's `.git` pointer. The metadata remains caller-owned and host-backed;
 * no repository data is copied into container-owned storage.
 * The install must allowlist the path's root (`SEALANT_MOUNT_ALLOWED_STORE_ROOTS`); paths
 * outside the allowlist are rejected at create. Credentials and dotfiles options compose
 * unchanged. Clone-based workspaces remain the right shape for independent verification.
 */
export interface WorkspaceMountSource {
  readonly kind: "mount";
  /** Absolute, normalized host path (no `..` segments). */
  readonly path: string;
}

/**
 * An ADDITIONAL caller-owned host directory bind-mounted beside the primary source — sibling
 * repositories, reference clones, scratch material the workspace should see without adopting.
 * Read-only by default: extra mounts widen what the workspace can see, not where its work product
 * lands. Same allowlist as mount sources (`SEALANT_MOUNT_ALLOWED_STORE_ROOTS`); the container path
 * must not overlap the working directory. Like the primary mount, the host path is caller-owned —
 * never reprovisioned, never cleaned.
 */
export interface WorkspaceExtraMount {
  /** Absolute, normalized host path (no `..` segments). */
  readonly hostPath: string;
  /** Absolute container path to mount at, outside the working directory (e.g. `/workspace/ref/x`). */
  readonly mountPath: string;
  /** Defaults to `true`. Pass `false` deliberately — writes to extra mounts are unrecorded. */
  readonly readOnly?: boolean;
}

/** Runtime-managed services attached only to this workspace. */
export interface WorkspaceServicesOptions {
  /**
   * Give the workspace a Docker client connected to its own disposable daemon. The platform never
   * mounts the host Docker socket.
   */
  readonly docker?: boolean;
}

export interface CreateOptions {
  /**
   * Source git repository to build the workspace around (e.g. `"github.com/acme/billing-service"`).
   * Exactly one of `repository` or `source` must be provided.
   */
  readonly repository?: string;
  /** Alternative to `repository`: source the workspace from a caller-owned mount. */
  readonly source?: WorkspaceMountSource;
  /** Additional read-only-by-default mounts beside the primary source (see `WorkspaceExtraMount`). */
  readonly mounts?: readonly WorkspaceExtraMount[];
  /** The harness to run inside the workspace. */
  readonly harness: Harness;
  /** Git ref to check out (defaults to the repository's default branch; `repository` only). */
  readonly ref?: string;
  /** Human-friendly name for the workspace. */
  readonly name?: string;
  /** OS family for the workspace image. */
  readonly os?: WorkspaceOs;
  /** Extra OS packages to install in the workspace. */
  readonly packages?: readonly string[];
  /** Runtime-managed services that need more than installing an OS package. */
  readonly services?: WorkspaceServicesOptions;
  /** When true (default), resolve only once the workspace runtime is live. */
  readonly wait?: boolean;
  /** Observe provisioning events as they happen. */
  readonly onEvent?: (event: WorkspaceEvent) => void;
  /** Connected-account credentials to attach to the workspace (see `WorkspaceCredentialsOptions`). */
  readonly credentials?: WorkspaceCredentialsOptions;
  /**
   * Time-to-live for the workspace, e.g. `"90m"`, `"2h"` (also `"45s"`, `"1d"`). Once it elapses
   * the platform stops the workspace and removes its container. Omitted = the server default TTL
   * (if the install configures one).
   */
  readonly ttl?: string;
}

export interface ListOptions {
  readonly status?: WorkspaceStatus;
  readonly limit?: number;
}

/** Options for a deterministic `workspace.exec()`. */
export interface WorkspaceExecOptions {
  /** Working directory inside the workspace (defaults to the repository root). */
  readonly cwd?: string;
}

/**
 * The settled result of a deterministic `workspace.exec()`. The exit code is a check DATUM — a
 * nonzero exit resolves normally (that's the point: `base fails` is a recorded fact, not an error).
 * `exec()` rejects only when the execution machinery itself broke, i.e. when the exit code cannot
 * be trusted.
 */
export interface WorkspaceExecResult {
  /** Exit code of the executed command. */
  readonly exitCode: number;
  /** Everything the command wrote to stdout, decoded as UTF-8. */
  readonly stdout: string;
  /** Everything the command wrote to stderr, decoded as UTF-8. */
  readonly stderr: string;
  /** The run this exec was recorded as — its `record` is the durable, replayable evidence. */
  readonly run: Run;
}

/** A live, disposable development environment around a real repository. */
export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** Current lifecycle status. */
  status(): Promise<WorkspaceStatus>;
  /** Resolves once the workspace runtime is live and ready to accept a run. */
  ready(): Promise<this>;
  /** Run a harness in this workspace. */
  readonly harness: HarnessRunner;
  /**
   * Execute one command deterministically in the workspace — no agent in the loop — recorded into a
   * run record like any other process. `argv[0]` is the executable, the rest its arguments.
   */
  exec(argv: readonly string[], options?: WorkspaceExecOptions): Promise<WorkspaceExecResult>;
  /** Interactive PTY sessions: open new ones, reattach to existing ones by id. */
  readonly sessions: WorkspaceSessions;
  /** Lifecycle events as an async stream. */
  events(): AsyncIterable<WorkspaceEvent>;
  /** Stop the workspace: remove its container and settle it in the terminal "stopped" status. */
  stop(): Promise<void>;
  /** Restart the workspace into a fresh runtime — a new container, no filesystem carry-over. */
  restart(): Promise<Workspace>;
  /**
   * Schedule the workspace to expire: `expire({ in: "2h" })` sets the TTL, `expire()` expires it
   * now (the platform reaper stops it shortly), `expire({ in: null })` clears the TTL.
   */
  expire(options?: { readonly in?: string | null }): Promise<void>;
  /**
   * Open a raw TCP byte pipe (or a UDP datagram pipe) INSIDE the workspace — the primitive for
   * reaching a dev server or database the workspace runs. Protocol-agnostic:
   * nothing inspects or records the payload. One held WebSocket per forward;
   * rejects when nothing accepts the connection. The target host is a CLOSED
   * workspace-private set: the container's loopback (default), or `docker` —
   * the workspace-scoped Docker sidecar's alias, where `docker compose`
   * publishes its ports.
   */
  forward(port: number, options?: WorkspaceForwardOptions): Promise<WorkspaceForward>;
}

/** Options for {@link Workspace.forward}. */
export interface WorkspaceForwardOptions {
  /** Target inside the workspace: its loopback (default) or the Docker sidecar. */
  readonly host?: "127.0.0.1" | "localhost" | "docker";
  /**
   * Forward transport. TCP (default) is a byte stream; `"udp"` opens a
   * connected UDP socket where one frame on this pipe is exactly one
   * datagram, both directions. UDP has no connection handshake: opening
   * succeeds even when nothing listens yet — datagrams simply drop.
   */
  readonly protocol?: "tcp" | "udp";
}

/**
 * A live port forward — one WebSocket, held until `close()` or the remote
 * closes. A raw duplex byte stream: write with `send`, read from `output`,
 * signal outbound EOF with `eof` (half-close; inbound keeps flowing).
 */
export interface WorkspaceForward {
  /** Write bytes toward the workspace port on the held socket. */
  send(input: Uint8Array): void;
  /** Half-close: no more outbound bytes; the remote's response keeps flowing. */
  eof(): void;
  /** Bytes from the workspace port, until the remote closes or `close()`. */
  readonly output: AsyncIterable<Uint8Array>;
  /** Resolves when the forward ends: the remote closed (`"end"`) or the socket closed. */
  readonly closed: Promise<"end" | "closed">;
  /** Tear the forward down. */
  close(): void;
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  /** Cancel the run by aborting this signal. */
  readonly signal?: AbortSignal;
  /** Idempotency key so a retried call does not start a duplicate run. */
  readonly idempotencyKey?: string;
  /**
   * Opaque correlation bag ({ projectId, sessionId, ... }): stored verbatim by the platform and
   * echoed on reads. No platform-side semantics.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Options for opening an interactive PTY session. */
export interface SessionOptions {
  /** Working directory inside the workspace (defaults to the repository root). */
  readonly cwd?: string;
  /** Extra environment for the PTY process (not for secrets — use `credentials`). */
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
  readonly term?: string;
  /** Opaque correlation bag, stored verbatim and echoed on reads. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Runs a harness in a workspace, one-shot or interactive. */
export interface HarnessRunner {
  /** BLOCKING: resolves once the harness has terminally completed; `result`/`changes` are settled. */
  run(prompt: string, options?: RunOptions): Promise<Run>;
  /** NON-BLOCKING: returns a live handle immediately for streaming via `run.record.stream()`. */
  start(prompt: string, options?: RunOptions): Promise<Run>;
  /** Opens an interactive PTY session running the harness's launch command. */
  session(options?: SessionOptions): Promise<InteractiveSession>;
}

export type RunOutcome = "completed" | "failed";

/** Lifecycle status of a run (harness execution). */
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RunResult {
  /** Raw lifecycle status (honest for non-terminal runs read via `runs.get`). */
  readonly status: RunStatus;
  /** Coarse terminal outcome: `completed` only when the run completed; otherwise `failed`. */
  readonly outcome: RunOutcome;
  readonly exitCode: number;
  readonly summary?: string;
}

export type FileChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface RunFileChange {
  readonly path: string;
  readonly change: FileChangeKind;
  /** Previous path for a rename. */
  readonly oldPath?: string;
}

export interface RunChanges {
  readonly files: readonly RunFileChange[];
  /** The unified diff of everything that changed. */
  diff(): Promise<string>;
}

export interface ArtifactRef {
  readonly name: string;
  readonly bytes: number;
  readonly contentType?: string;
}

export interface RunArtifacts {
  list(): Promise<readonly ArtifactRef[]>;
  get(name: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------------------------
// Record events — the typed taxonomy behind the timeline
// ---------------------------------------------------------------------------------------------
//
// HAND-WRITTEN mirrors of the platform's record-event payloads (mapped in the facade via the
// `@sealant/api-contracts` schemas). Conventions, straight from the wire: uint64/int64 fields are
// DECIMAL STRINGS (values past 2^53 survive), and protocol enum fields are NUMBERS (`RuntimeState`,
// `ExitReason`, `StreamKind` — stdout = 2, stderr = 3 —, `FileChangeKind`, `FileType`,
// `NetworkScheme`, `EventPriority`).

/** The runtime daemon's lifecycle state changed. `state` is a numeric `RuntimeState`. */
export interface RuntimeStateChangedEvent {
  readonly state: number;
  readonly reason?: string | undefined;
}

/** Periodic runtime liveness signal. `state` is a numeric `RuntimeState`. */
export interface RuntimeHeartbeatEvent {
  readonly state: number;
}

/** A supervised process began executing. */
export interface ProcessStartedEvent {
  readonly pid: number;
  readonly pgid: number;
  readonly pidfd: boolean;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Wall clock at start, microseconds (decimal string). */
  readonly startedAt: string;
}

/** A supervised process ended. `reason` is a numeric `ExitReason`. */
export interface ProcessExitedEvent {
  readonly exitCode?: number | undefined;
  readonly signal?: number | undefined;
  readonly reason: number;
  /** Wall-clock duration, microseconds (decimal string). */
  readonly durationMicros: string;
}

/**
 * A run of process output. Raw bytes live in the artifact store (fetch byte-exact text via
 * `record.scrollback()`); the event carries counts and a content hash. `stream` is a numeric
 * `StreamKind` (stdout = 2, stderr = 3).
 */
export interface IoChunkEvent {
  readonly stream: number;
  readonly byteCount: string;
  readonly streamOffset: string;
  readonly contentAlgo?: string | undefined;
  readonly contentHash?: string | undefined;
  readonly transform?:
    | {
        readonly redacted: boolean;
        readonly truncated: boolean;
        readonly coalesced: boolean;
        readonly originalByteCount?: string | undefined;
      }
    | undefined;
}

/** The runtime dropped events under pressure. `priority` is a numeric `EventPriority`. */
export interface TelemetryDroppedEvent {
  readonly reason: string;
  readonly count: string;
  readonly priority: number;
}

/** Filesystem entry metadata attached to a change. `fileType` is a numeric `FileType`. */
export interface FileEntryData {
  readonly path: string;
  readonly fileType: number;
  readonly size: string;
  readonly mtimeMicros: string;
  readonly mode: number;
  readonly hash?: string | undefined;
  readonly symlinkTarget?: string | undefined;
}

/** A watched file changed. `kind` is a numeric `FileChangeKind`. */
export interface FileChangeEvent {
  readonly kind: number;
  readonly path: string;
  readonly renameFrom?: string | undefined;
  readonly entry?: FileEntryData | undefined;
  readonly certain: boolean;
}

/** The file watcher overflowed — changes under `root` may have been missed. */
export interface FileWatchOverflowEvent {
  readonly root: string;
}

/** A filesystem snapshot pass finished. */
export interface FileSnapshotCompletedEvent {
  readonly root: string;
  readonly fileCount: string;
}

/** Aggregate before/after diff counts became available. */
export interface FileDiffAvailableEvent {
  readonly added: string;
  readonly modified: string;
  readonly deleted: string;
  readonly renamed: string;
}

/** An outbound network request the run made. `scheme` is a numeric `NetworkScheme`. */
export interface NetworkRequestEvent {
  readonly scheme: number;
  readonly method?: string | undefined;
  readonly host: string;
  readonly port: number;
  readonly path?: string | undefined;
  readonly status?: number | undefined;
  readonly bytesSent: string;
  readonly bytesReceived: string;
  readonly durationMicros: string;
}

/** A network source the run touched — the raw material of a "sources the agent opened" trail. */
export interface NetworkSourceObservedEvent {
  readonly host: string;
  readonly resolvedIps: readonly string[];
  readonly port: number;
  readonly scheme?: number | undefined;
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  readonly status?: number | undefined;
}

/** Fields shared by every timeline entry, independent of its kind. */
export interface TimelineEntryBase {
  readonly sequence: bigint;
  readonly occurredAt: string;
  /** One-line human summary of the event. */
  readonly summary: string;
  /** Correlation id of the producing process, when attributable. */
  readonly processId?: string | undefined;
}

/**
 * A single ordered entry in the execution record's timeline, DISCRIMINATED by `kind`: switch on it
 * and `data` narrows to the event's typed payload. The `"unknown"` case is the forward-compatibility
 * path — it carries kinds newer than this SDK (or payloads that failed their schema) with the wire
 * kind preserved in `rawKind` and the payload verbatim in `data`.
 */
export type TimelineEntry =
  | (TimelineEntryBase & {
      readonly kind: "runtimeStateChanged";
      readonly data: RuntimeStateChangedEvent;
    })
  | (TimelineEntryBase & {
      readonly kind: "runtimeHeartbeat";
      readonly data: RuntimeHeartbeatEvent;
    })
  | (TimelineEntryBase & { readonly kind: "processStarted"; readonly data: ProcessStartedEvent })
  | (TimelineEntryBase & { readonly kind: "processExited"; readonly data: ProcessExitedEvent })
  | (TimelineEntryBase & { readonly kind: "ioChunk"; readonly data: IoChunkEvent })
  | (TimelineEntryBase & {
      readonly kind: "telemetryDropped";
      readonly data: TelemetryDroppedEvent;
    })
  | (TimelineEntryBase & { readonly kind: "fileChange"; readonly data: FileChangeEvent })
  | (TimelineEntryBase & {
      readonly kind: "fileWatchOverflow";
      readonly data: FileWatchOverflowEvent;
    })
  | (TimelineEntryBase & {
      readonly kind: "fileSnapshotCompleted";
      readonly data: FileSnapshotCompletedEvent;
    })
  | (TimelineEntryBase & {
      readonly kind: "fileDiffAvailable";
      readonly data: FileDiffAvailableEvent;
    })
  | (TimelineEntryBase & { readonly kind: "networkRequest"; readonly data: NetworkRequestEvent })
  | (TimelineEntryBase & {
      readonly kind: "networkSourceObserved";
      readonly data: NetworkSourceObservedEvent;
    })
  | (TimelineEntryBase & {
      readonly kind: "unknown";
      /** The kind as received on the wire — set when this SDK version doesn't model it. */
      readonly rawKind: string;
      readonly data: unknown;
    });

/** A re-fold of the record up to some point — scrubable by sequence. */
export interface RunReplay {
  readonly entries: readonly TimelineEntry[];
  /** The entry at (or the last entry at-or-before) `sequence`. */
  at(sequence: bigint): TimelineEntry | undefined;
}

/** One terminal command the run executed, reconstructed from the record (not raw event noise). */
export interface RunCommand {
  /** The executable that ran (e.g. `"opencode"`). */
  readonly executable: string;
  /** Its arguments. */
  readonly args: readonly string[];
  /** A ready-to-read shell line, e.g. `opencode run "fix the test"`. */
  readonly command: string;
  /** Working directory the command ran in. */
  readonly cwd?: string;
  /** Exit code, when the command exited normally. */
  readonly exitCode?: number;
  /** Signal number, when the command was terminated by a signal instead. */
  readonly signal?: number;
  /** Wall-clock duration in milliseconds, when known. */
  readonly durationMs?: number;
  /** Bytes the command wrote to stdout / stderr (full text is available via `scrollback`). */
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

/** Provenance-honest report of any gaps detected in the recorded stream. */
export interface LossReport {
  readonly complete: boolean;
  // Boundaries are optional: some span kinds (early_close, a bare dropped-count) carry no sequence
  // range. They are passed through only when present — never fabricated.
  readonly spans: readonly { readonly fromSequence?: bigint; readonly toSequence?: bigint }[];
}

export interface RunSummary {
  readonly runId: string;
  readonly outcome: RunOutcome;
  readonly entries: number;
  readonly durationMs?: number;
}

/** Output streams a process can write to. */
export type IoStream = "stdout" | "stderr";

/**
 * The execution record for a run: the durable, replayable history. Backed by the telemetry read
 * facade. `replay()`/`timeline()`/`scrollback()`/`stream()` are available in the current slice; the
 * time-travel folds (`fileTreeAt`/`processTreeAt`) reject until their read models land.
 */
export interface RunRecord {
  readonly runId: string;
  /** Re-fold the full record into a scrubable replay (low-level: every timeline entry). */
  replay(options?: {
    readonly speed?: number;
    readonly onEntry?: (entry: TimelineEntry) => void;
  }): Promise<RunReplay>;
  /** The terminal commands the run executed — what the harness actually did, reconstructed. */
  commands(): Promise<readonly RunCommand[]>;
  /** A human-readable transcript: the commands and their outcomes, nicely laid out (no event noise). */
  transcript(): Promise<string>;
  /** Subscribe to the live event stream while the run is in progress (poll-backed; SSE later). */
  stream(options?: { readonly from?: bigint }): AsyncIterable<TimelineEntry>;
  /** Iterate the full timeline as structured data. */
  timeline(options?: { readonly from?: bigint }): AsyncIterable<TimelineEntry>;
  /** Byte-exact scrollback for a process's output stream. */
  scrollback(processId: string, stream: IoStream): AsyncIterable<Uint8Array>;
  /** Provenance-honest loss report. */
  loss(): Promise<LossReport>;
  /** A compact summary of the run. */
  summary(): Promise<RunSummary>;
  /** File-tree snapshot at a point in time (Phase 1 — rejects until backed). */
  fileTreeAt(sequence: bigint): Promise<unknown>;
  /** Process-tree snapshot at a point in time (Phase 1 — rejects until backed). */
  processTreeAt(sequence: bigint): Promise<unknown>;
}

/** One unit of developer work: what it produced and how it happened. */
export interface Run {
  readonly id: string;
  /** Terminal result (settled once `run()` resolves). */
  readonly result: RunResult;
  /** The before/after of what changed. */
  readonly changes: RunChanges;
  /** Retained artifacts. */
  readonly artifacts: RunArtifacts;
  /** The execution record. */
  readonly record: RunRecord;
  /** Resolves once the run has terminally completed (no-op if already settled). */
  wait(): Promise<Run>;
}

/** Lifecycle status of an interactive session. */
export type SessionStatus = "starting" | "running" | "exited" | "failed";

/** One recorded output chunk. `sequence` is the durable resume cursor. */
export interface SessionOutputChunk {
  readonly sequence: bigint;
  readonly data: Uint8Array;
}

/** A point-in-time report of an interactive session's lifecycle. */
export interface InteractiveSessionStatus {
  readonly status: SessionStatus;
  readonly exitCode?: number;
  readonly exitSignal?: number;
  /**
   * Highest recorded output sequence — resume a disconnected reader with
   * `output({ from: outputHighWater + 1n })` (or re-read from `0n` for full history).
   */
  readonly outputHighWater: bigint;
}

/**
 * An interactive PTY session over a live workspace. Sessions are DURABLE PLATFORM RESOURCES, not
 * client connections: the PTY keeps running when this handle (or the whole process) goes away, and
 * a session can be re-fetched by id from any workspace handle (`workspace.sessions.get(id)`) and
 * driven from there. Output is byte-exact, redacted, and sequence-keyed — `output({ from: 0n })`
 * after a reconnect replays the full recorded history and then live-tails.
 */
export interface InteractiveSession {
  readonly id: string;
  readonly workspaceId: string;
  /** The run recording this session — its record is the durable, replayable evidence. */
  readonly runId: string;
  /** Send keystrokes. Strings are UTF-8-encoded; bytes pass through untouched. */
  send(input: string | Uint8Array): Promise<void>;
  /**
   * Byte-exact output as a RESUMABLE stream: recorded history from `from` (inclusive; default the
   * beginning), then the live tail until the session settles. Each chunk carries its durable
   * sequence, so a disconnected consumer resumes with `from: lastChunk.sequence + 1n`.
   */
  output(options?: {
    readonly from?: bigint;
    readonly signal?: AbortSignal;
  }): AsyncIterable<SessionOutputChunk>;
  /** Resize the PTY. */
  resize(cols: number, rows: number): Promise<void>;
  /** Deliver a POSIX signal to the session's process (e.g. 2 = SIGINT). */
  signal(signal: number): Promise<void>;
  /** Current lifecycle + the output high-water mark (the resume cursor). */
  status(): Promise<InteractiveSessionStatus>;
  /** Close the PTY (hang up the terminal). Resolves once the session settles. */
  close(): Promise<void>;
  /**
   * THE DATA PLANE for interactive terminals: one held WebSocket carrying
   * input, output, and resize — auth once at connect, no per-keystroke
   * requests. Output replays byte-exact from `from` and then live-tails.
   * `send`/`resize`/`signal`/`output` above remain the request/response
   * control-plane verbs; a terminal UI should attach instead.
   */
  attach(options?: SessionAttachOptions): Promise<SessionAttachment>;
}

/** Options for {@link InteractiveSession.attach}. */
export interface SessionAttachOptions {
  /** Replay output from this sequence (inclusive; default `0n` = full history). */
  readonly from?: bigint;
}

/**
 * A live terminal attachment — one WebSocket, held until `close()` or the
 * session settles. Not durable: reattach by calling `attach` again.
 */
export interface SessionAttachment {
  /** Write keystrokes onto the held socket (no request/response round-trip). */
  send(input: string | Uint8Array): void;
  /** Resize the PTY over the held socket. */
  resize(cols: number, rows: number): void;
  /** Output bytes: recorded replay from `from`, then live, until settle/close. */
  readonly output: AsyncIterable<Uint8Array>;
  /** Resolves when the attachment ends: session settled (`"end"`) or the socket closed. */
  readonly closed: Promise<"end" | "closed">;
  /** Drop the attachment (the session keeps running). */
  close(): void;
}

/** Interactive sessions of one workspace: open new ones, reattach to existing ones. */
export interface WorkspaceSessions {
  /** Opens a PTY session running `argv` (argv[0] is the program). */
  open(argv: readonly string[], options?: SessionOptions): Promise<InteractiveSession>;
  /** Reattach to a session by id — works from ANY handle, not just the creating one. */
  get(sessionId: string): Promise<InteractiveSession>;
  /** Sessions of this workspace, newest first. */
  list(): Promise<readonly InteractiveSession[]>;
}

// ---------------------------------------------------------------------------------------------
// Access tokens — scoped credentials for the session surface
// ---------------------------------------------------------------------------------------------

/**
 * Scopes for the session surface: `session:read` (stream/status/output), `session:input`
 * (input/resize/signal), `workspace:exec` (open sessions/terminals, exec). A client holding only
 * `session:read` can stream output but is rejected for input and exec.
 */
export type AccessTokenScope = "session:read" | "session:input" | "workspace:exec";

export interface CreateAccessTokenOptions {
  readonly scopes: readonly AccessTokenScope[];
  readonly name?: string;
  /** Narrow the token to one workspace. */
  readonly workspaceId?: string;
  /** Time-to-live, e.g. `"15m"`, `"2h"`. Omitted = no expiry. */
  readonly ttl?: string;
}

export interface CreatedAccessToken {
  readonly tokenId: string;
  /** The bearer secret — shown exactly once, never retrievable again. Use it as `apiKey`. */
  readonly token: string;
  readonly scopes: readonly AccessTokenScope[];
  readonly workspaceId?: string;
  readonly expiresAt?: string;
}

/** Mint scoped bearer tokens (e.g. for a mobile pairing flow's per-scope grants). */
export interface AccessTokensNamespace {
  create(options: CreateAccessTokenOptions): Promise<CreatedAccessToken>;
}

// ---------------------------------------------------------------------------------------------
// Inference on connected accounts
// ---------------------------------------------------------------------------------------------

/**
 * Connected-account selection for inference — the same reference shape as workspace creation,
 * minus GitHub (not a model provider). `true` means "my default account"; a string names one.
 * Only claude accounts are supported today; a codex selection is rejected until Codex inference
 * ships. SECURITY: only account references cross this surface — never token material.
 */
export interface InferenceCredentialsOptions {
  /** Profile id whose claude binding applies when `claude` is not set explicitly. */
  readonly profile?: string;
  /** `true` for the caller's default claude account, or a string naming a specific one. */
  readonly claude?: boolean | string;
  /** Reserved — rejected until Codex inference ships. */
  readonly codex?: boolean | string;
}

/** A caller-defined tool the model may call. `inputSchema` is a JSON Schema object, verbatim. */
export interface InferenceToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

/** A tool call the model made. Execute it YOUR side, then respond with an `InferenceToolResult`. */
export interface InferenceToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
}

/** Your result for one tool call, keyed by its `toolCallId`. */
export interface InferenceToolResult {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError?: boolean;
}

/** The assistant turn: the final text (with parsed `json` when requested) or pending tool calls. */
export type InferenceTurn =
  | { readonly type: "text"; readonly text: string; readonly json?: unknown }
  | { readonly type: "toolCalls"; readonly calls: readonly InferenceToolCall[] };

export interface InferenceUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface InferenceResponse {
  /** Continuation handle for the tool loop (held in memory server-side; expires after idle). */
  readonly sessionId: string;
  readonly turn: InferenceTurn;
  /** Usage for the exchange, present on the final text turn. */
  readonly usage?: InferenceUsage;
}

/** Starts a new inference exchange on a connected account. */
export interface InferenceRespondOptions {
  readonly prompt: string;
  readonly system?: string;
  readonly model?: string;
  /** Upper bound on agentic turns within the exchange (server default 16). */
  readonly maxTurns?: number;
  readonly tools?: readonly InferenceToolDefinition[];
  /** Structured output: reply as JSON (schema-constrained when `schema` is given). */
  readonly responseFormat?: { readonly type: "json"; readonly schema?: unknown };
  readonly credentials: InferenceCredentialsOptions;
}

/** Continues an exchange by posting the results of the previous turn's tool calls. */
export interface InferenceContinueOptions {
  readonly sessionId: string;
  readonly toolResults: readonly InferenceToolResult[];
}

/**
 * Inference on connected accounts. The model call runs SERVER-SIDE through the official agent SDKs
 * on the resolved account's credential (never raw model-API calls); the tool loop is CALLER-
 * EXECUTED — a `toolCalls` turn parks server-side until you `respond()` with the results:
 *
 *   let response = await sealant.inference.respond({ prompt, tools, credentials: { claude: true } })
 *   while (response.turn.type === "toolCalls") {
 *     const toolResults = await runTools(response.turn.calls)
 *     response = await sealant.inference.respond({ sessionId: response.sessionId, toolResults })
 *   }
 *   response.turn.text
 */
export interface InferenceNamespace {
  respond(options: InferenceRespondOptions | InferenceContinueOptions): Promise<InferenceResponse>;
}
