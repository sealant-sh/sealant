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

/** Lifecycle status of a workspace. `stopped`/`expired` arrive with lifecycle close-out (Phase 3). */
export type WorkspaceStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

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

export interface CreateOptions {
  /** Source git repository to build the workspace around (e.g. `"github.com/acme/billing-service"`). */
  readonly repository: string;
  /** The harness to run inside the workspace. */
  readonly harness: Harness;
  /** Git ref to check out (defaults to the repository's default branch). */
  readonly ref?: string;
  /** Human-friendly name for the workspace. */
  readonly name?: string;
  /** OS family for the workspace image. */
  readonly os?: WorkspaceOs;
  /** Extra OS packages to install in the workspace. */
  readonly packages?: readonly string[];
  /** When true (default), resolve only once the workspace runtime is live. */
  readonly wait?: boolean;
  /** Observe provisioning events as they happen. */
  readonly onEvent?: (event: WorkspaceEvent) => void;
  /** Connected-account credentials to attach to the workspace (see `WorkspaceCredentialsOptions`). */
  readonly credentials?: WorkspaceCredentialsOptions;
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
  /** Lifecycle events as an async stream. */
  events(): AsyncIterable<WorkspaceEvent>;
  /** Stop the workspace now (Phase 3). */
  stop(): Promise<void>;
  /** Restart the workspace into a fresh runtime (Phase 3). */
  restart(): Promise<Workspace>;
  /** Schedule the workspace to expire (Phase 3). */
  expire(options?: { readonly in?: string }): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  /** Cancel the run by aborting this signal. */
  readonly signal?: AbortSignal;
  /** Idempotency key so a retried call does not start a duplicate run. */
  readonly idempotencyKey?: string;
}

export interface SessionOptions {
  readonly signal?: AbortSignal;
}

/** Runs a harness in a workspace, one-shot or interactive. */
export interface HarnessRunner {
  /** BLOCKING: resolves once the harness has terminally completed; `result`/`changes` are settled. */
  run(prompt: string, options?: RunOptions): Promise<Run>;
  /** NON-BLOCKING: returns a live handle immediately for streaming via `run.record.stream()`. */
  start(prompt: string, options?: RunOptions): Promise<Run>;
  /** Interactive session reusing the live workspace (Phase 3). */
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

/** An interactive harness session over the live workspace (Phase 3). */
export interface InteractiveSession {
  send(input: string): Promise<void>;
  output(): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
