/**
 * The Sealant SDK public type surface.
 *
 * This is the fluent object model the marketing site commits to verbatim:
 *
 *   const sandbox = await sealant.sandboxes.create({ repository, harness: opencode() })
 *   const run = await sandbox.harness.run("Round invoice totals once, after applying the discount.")
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

/** A single one-shot command to invoke a harness against a prompt inside the sandbox. */
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
// Sandboxes
// ---------------------------------------------------------------------------------------------

/** Lifecycle status of a sandbox. `stopped`/`expired` arrive with lifecycle close-out (Phase 3). */
export type SandboxStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

/** A coarse lifecycle event observed while a sandbox is being provisioned. */
export interface SandboxEvent {
  readonly type: string;
  readonly occurredAt: string;
  readonly message?: string;
}

/** The supported sandbox OS families (maps to the blueprint target). */
export type SandboxOs = "fedora" | "arch" | "nix";

export interface CreateOptions {
  /** Source git repository to build the sandbox around (e.g. `"github.com/acme/billing-service"`). */
  readonly repository: string;
  /** The harness to run inside the sandbox. */
  readonly harness: Harness;
  /** Git ref to check out (defaults to the repository's default branch). */
  readonly ref?: string;
  /** Human-friendly name for the sandbox. */
  readonly name?: string;
  /** OS family for the sandbox image. */
  readonly os?: SandboxOs;
  /** Extra OS packages to install in the sandbox. */
  readonly packages?: readonly string[];
  /** When true (default), resolve only once the sandbox runtime is live. */
  readonly wait?: boolean;
  /** Observe provisioning events as they happen. */
  readonly onEvent?: (event: SandboxEvent) => void;
}

export interface ListOptions {
  readonly status?: SandboxStatus;
  readonly limit?: number;
}

/** A live, disposable development environment around a real repository. */
export interface Sandbox {
  readonly id: string;
  readonly name: string;
  /** Current lifecycle status. */
  status(): Promise<SandboxStatus>;
  /** Resolves once the sandbox runtime is live and ready to accept a run. */
  ready(): Promise<this>;
  /** Run a harness in this sandbox. */
  readonly harness: HarnessRunner;
  /** Lifecycle events as an async stream. */
  events(): AsyncIterable<SandboxEvent>;
  /** Stop the sandbox now (Phase 3). */
  stop(): Promise<void>;
  /** Restart the sandbox into a fresh runtime (Phase 3). */
  restart(): Promise<Sandbox>;
  /** Schedule the sandbox to expire (Phase 3). */
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

/** Runs a harness in a sandbox, one-shot or interactive. */
export interface HarnessRunner {
  /** BLOCKING: resolves once the harness has terminally completed; `result`/`changes` are settled. */
  run(prompt: string, options?: RunOptions): Promise<Run>;
  /** NON-BLOCKING: returns a live handle immediately for streaming via `run.record.stream()`. */
  start(prompt: string, options?: RunOptions): Promise<Run>;
  /** Interactive session reusing the live sandbox (Phase 3). */
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

/** A single ordered entry in the execution record's timeline. */
export interface TimelineEntry {
  readonly sequence: bigint;
  readonly kind: string;
  readonly occurredAt: string;
  readonly data: unknown;
}

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
 * facade. `replay()`/`timeline()`/`scrollback()` are available in the current slice; the time-travel
 * folds (`fileTreeAt`/`processTreeAt`) and the live `stream()` reject until their read models land.
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
  /** Subscribe to the live event stream while the run is in progress (Phase 2). */
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

/** An interactive harness session over the live sandbox (Phase 3). */
export interface InteractiveSession {
  send(input: string): Promise<void>;
  output(): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
