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
  /**
   * Bearer secret for authenticated deployments: a SERVICE KEY (`SEALANT_SERVICE_KEYS` on the
   * control plane — lets this client act on behalf of any `ownerUserId`) or a scoped user access
   * token (session surface only). Optional for a localhost demo with no auth.
   */
  readonly apiKey?: string;
  /**
   * The user every call is attributed to. A product that owns its own login builds ONE client per
   * user with that user's Sealant id (see `users.ensure`). Defaults to `SEALANT_OWNER_USER_ID`,
   * then `usr_local`.
   */
  readonly ownerUserId?: string;
  /** Override the `fetch` implementation (tests, custom agents, proxies). */
  readonly fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------------------------

/** The harnesses with first-class integrations baked into the platform today. */
export type HarnessId = "opencode" | "codex" | "claude-code" | "pi";

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

/**
 * Lifecycle status of a workspace.
 *
 * `retained`: its executor ended (or its capture launch failed after it started) with work on
 * its disk not confirmed saved. It is KEPT, not dead: the control plane drains or recovers it
 * with the capture token it was launched with, and the status reads `stopped` or `failed` again
 * only once that ends (saved and removed, discarded, or lost). Keep what the recovery needs — the
 * session's lease and token — while it reads `retained`. `details().captureDrain.retained` says
 * why, and how recovery is going.
 */
export type WorkspaceStatus =
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "cancelled"
  | "stopped"
  | "retained";

/** A coarse lifecycle event observed while a workspace is being provisioned. */
export interface WorkspaceEvent {
  readonly type: string;
  readonly occurredAt: string;
  readonly message?: string;
}

/** The supported workspace OS families (maps to the blueprint target). */
/** Supported workspace image OS families. `fedora` is the default when `os` is omitted. */
export type WorkspaceOs = "fedora" | "arch" | "nix" | "ubuntu";

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
 * mounts `path` as the workspace working directory and treats it as caller-owned: writes persist
 * across workspace stop/restart/expiry, and the path is never reprovisioned or deleted. In strict
 * Docker volume mode this is the canonical absolute path visible inside the application and worker
 * containers, not Docker's private host volume directory. When `path` is a linked Git worktree, the
 * SDK also mounts its shared Git metadata at the absolute path named by the worktree's `.git`
 * pointer. No repository data is copied into workspace-container-owned storage.
 * The install must allowlist the path's root (`SEALANT_MOUNT_ALLOWED_STORE_ROOTS`); paths
 * outside the allowlist are rejected at create. Credentials and dotfiles options compose
 * unchanged. Clone-based workspaces remain the right shape for independent verification.
 */
export interface WorkspaceMountSource {
  readonly kind: "mount";
  /** Absolute, normalized deployment path (no `..` segments); container-visible in volume mode. */
  readonly path: string;
}

/**
 * A STANDBY workspace (sealantd ADR-0014): the caller-owned ROOT directory — a project's
 * worktrees directory — is mounted hidden, and the working directory does not exist until
 * `workspace.bind({ subpath })` points it at one of the root's subdirectories. This is what lets a
 * pool of ready workspaces serve ANY worktree of a project, and lets one workspace be re-pointed.
 * Same allowlist as a mount source. The worktrees' shared git metadata (the bare repository the
 * `.git` files point at) must ride as an explicit extra mount at its own absolute path.
 */
export interface WorkspaceStandbySource {
  readonly kind: "standby";
  /** Absolute, normalized deployment root (no `..` segments); container-visible in volume mode. */
  readonly rootPath: string;
}

/**
 * A CAPTURE workspace (sealantd ADR-0015): the platform mounts nothing and clones nothing. The
 * workspace daemon registers with the session channel at `endpoint` using `token`, fetches the
 * worktree's head plan, materialises it onto the executor's own disk, claims the lease and ships
 * captures back over the channel — so the same session can run on a host that has no path to
 * offer (Cloudflare, a MicroVM) and outlive any one executor. `token` is delivered once, through
 * the secret env channel (`SEALANT_CAPTURE_TOKEN`), never into the blueprint or any read; a
 * capture workspace therefore cannot be restarted in place — create a replacement with a fresh
 * token. `platform` is a hint recorded for placement bookkeeping. The control plane refuses an
 * `endpoint` outside the operator's approved origins (when any are set) and a plain-HTTP endpoint
 * beyond loopback that `transport.plaintext` does not account for.
 */
export interface WorkspaceCaptureSource {
  readonly kind: "capture";
  /** The session channel URL the daemon registers with. */
  readonly endpoint: string;
  /**
   * The worktree whose captures this workspace materialises and extends. Omit for a standby
   * executor launched before its worktree exists: the daemon then takes the worktree from the
   * channel's plan answer, which names the one it is bound to at claim.
   */
  readonly worktreeId?: string;
  /** The session-scoped channel credential. Secret: sealed for the launch, then discarded. */
  readonly token: string;
  /**
   * Absolute executor-local directory whose contents the daemon captures under `harness/` and
   * restores before the harness starts. Configure the harness to write its state there.
   */
  readonly harnessHome?: string;
  readonly platform?: string;
  /**
   * How the executor dials the channel and its object URLs. Omitted, the daemon requires HTTPS
   * with a certificate the public roots verify, and refuses to boot otherwise.
   */
  readonly transport?: WorkspaceCaptureTransport;
}

/** Transport for a capture source (sealantd ADR-0015 "Transport"). Certificates are public material. */
export interface WorkspaceCaptureTransport {
  /**
   * Your statement that the network between the executor and the channel is private (a VPC, a
   * cluster network, a Docker network), so plain HTTP may be dialled. Never set it for a channel
   * reached over the Internet.
   */
  readonly plaintext?: boolean;
  /** PEM roots the channel's certificate must chain to, in place of the public roots. */
  readonly channelCaPem?: string;
  /** PEM roots presigned object URLs must chain to, in place of the public roots. */
  readonly objectCaPem?: string;
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
  /** Absolute, normalized deployment path (no `..` segments); container-visible in volume mode. */
  readonly hostPath: string;
  /** Absolute container path to mount at, outside the working directory (e.g. `/workspace/ref/x`). */
  readonly mountPath: string;
  /** Defaults to `true`. Pass `false` deliberately — writes to extra mounts are unrecorded. */
  readonly readOnly?: boolean;
  /**
   * Bindable (sealantd ADR-0014): `hostPath` is a ROOT mounted hidden, and `mountPath` becomes a
   * symlink `workspace.bind({ mountPath, subpath })` points at one of the root's subdirectories.
   * A sibling repository's worktrees directory, bound to one worktree at first use.
   */
  readonly bindable?: boolean;
}

/** One live binding: `mountPath` points at `<root>/<subpath>`. */
export interface WorkspaceBind {
  readonly mountPath: string;
  readonly subpath: string;
}

export interface WorkspaceBindOptions {
  /** The bindable mount to point; defaults to the working directory (a standby source). */
  readonly mountPath?: string;
  /** Relative path under the mount's root; an empty string unbinds. */
  readonly subpath: string;
}

/** The daemon's capture status after `workspace.capture.flush()` (sealantd ADR-0015). */
export interface WorkspaceCaptureStatus {
  /** The lease epoch the captures were shipped under. */
  readonly epoch: number;
  readonly worktreeId: string;
  /** The head sequence registered on the session channel, once anything has been. */
  readonly headN?: number;
  /** Captures still staged and not yet shipped; zero after a complete flush. */
  readonly pending: number;
  readonly stagedBytes: number;
  readonly uploadedObjects: number;
  readonly uploadedBytes: number;
  readonly registered: number;
  /** The channel fenced this executor: nothing it captures from now on is accepted. */
  readonly fenced: boolean;
  /** The harness is paused (lease lost); see the daemon's lease semantics. */
  readonly paused: boolean;
  readonly lastSnapUnixMs?: number;
  /**
   * Capture classes the registrar refused for the session's byte quota: nothing of these ships
   * until the next epoch or re-plan, whatever `pending` says. Non-empty means work is NOT being
   * saved. Empty when the control plane predates the field.
   */
  readonly refused: readonly ("small" | "bulk")[];
  /** Bytes still to ship; present once the daemon reports it. */
  readonly pendingBytes?: number;
  /** Bulk captures (dependency trees, build output) still pending; present once reported. */
  readonly pendingBulk?: number;
  /**
   * The daemon's account of its last FINAL flush (the executor is ending): true only when it
   * quiesced every process, snapshotted everything and registered it. The only proof the
   * executor's work is saved — `pending === 0` alone is not. Absent until the daemon reports it;
   * read absent as not complete.
   */
  readonly complete?: boolean;
  /**
   * Why the last final flush is not complete, when the daemon says: `not-final`, `in-progress`,
   * `processes-remain`, `sweep-unavailable`, `snapshot-failed`, `unreadable`, `fenced`,
   * `conflict`, `deadline`, `ship-failed`, `pending`, `internal`.
   */
  readonly incompleteReason?: string;
  /**
   * Paths the last snap of each class could not read, summed over both classes. Never taken as
   * deleted: an automatic snap carries the last captured content forward, a final snap fails.
   */
  readonly unreadable?: number;
  /** Of `unreadable`, the paths whose last captured content was carried forward. */
  readonly carried?: number;
  /**
   * The first unreadable paths (at most 20), virtual: `tree/<path>`, `.git/<path>`,
   * `harness/<path>`; small class first.
   */
  readonly unreadablePaths?: readonly string[];
  /**
   * A capture the registrar refused to register that the executor is working through
   * (`missing-objects` or `unrestorable`). Nothing is dropped: it is rebuilt from disk.
   */
  readonly registerRefused?: string;
  /** That refused capture's chain position. */
  readonly registerRefusedN?: number;
  /** The first keys (at most 20) the registrar named as missing. */
  readonly registerMissing?: readonly string[];
  /** Register refusals the daemon has seen since it started. */
  readonly registerRefusals?: number;
  /** The refused capture waits to be rebuilt from disk; nothing behind it registers first. */
  readonly repairing?: boolean;
  /**
   * A bulk build is in progress: its capture is not queued yet, so `pending` does not count it.
   * The executor's work is not all saved while this is true.
   */
  readonly bulkBuilding?: boolean;
  /**
   * Each captured class's snaps: how many failed since the daemon started, and the last one's
   * error while it fails. A snap that fails stages nothing: what changed since the last capture
   * is on the executor's disk only.
   */
  readonly snaps?: readonly WorkspaceCaptureClassSnaps[];
  /**
   * From `snaps`: the error of the class that has been failing longest. Present means the newest
   * work is NOT being captured, whatever `pending` says.
   */
  readonly lastSnapError?: string;
  /** From `snaps`: when the earliest current run of failed snaps began (Unix ms). */
  readonly snapFailingSinceUnixMs?: number;
  /** From `snaps`: failed snaps of every class since the daemon started. */
  readonly snapsFailed?: number;
  /**
   * Where in the executor's own history this answer was made. Order evidence about one executor
   * by it — never by any clock: a later position is the newer answer. Absent from a daemon (or
   * control plane) that predates it; such answers cannot be ordered by position.
   */
  readonly origin?: WorkspaceCaptureOrigin;
  /**
   * A capture step running past its bound, while one is: the executor's capture is stuck there
   * now. Not a verdict — the step's own limit ends it and the snap fails (`snaps`). Absent while
   * nothing is past its bound, and from a daemon or control plane that predates it.
   */
  readonly overdue?: WorkspaceCaptureOverdue;
}

/** A capture step past its bound (`WorkspaceCaptureStatus.overdue`). */
export interface WorkspaceCaptureOverdue {
  /** What is running, outermost first, `›`-separated: `small snap › git cat-file --batch-check`. */
  readonly step: string;
  /** When it started, Unix ms (display only: order evidence by `origin`). */
  readonly startedUnixMs: number;
  /** How long it had been running when the answer was made, ms. */
  readonly runningMs: number;
  /** How long it is expected to take at most, ms. */
  readonly boundMs: number;
}

/**
 * An executor-origin position (sealantd's stamp on every status, FINAL answer and seal): the
 * capture lease epoch, the launch the executor runs as, the daemon boot that answered, how many
 * daemon boots opened its disk (0: unknown), an observation number that only grows within that
 * boot, and the capture head. Of the same epoch, launch and boot, order by `observation`; of the
 * same epoch and launch and different boots whose generations are both above 0 and differ, by
 * (`bootGeneration`, `observation`); anything else cannot be ordered.
 */
export interface WorkspaceCaptureOrigin {
  readonly epoch: number;
  readonly launch: string;
  readonly bootId: string;
  readonly bootGeneration: number;
  readonly observation: number;
  readonly headN?: number;
}

/** One capture class's snaps, as `WorkspaceCaptureStatus.snaps` reports them. */
export interface WorkspaceCaptureClassSnaps {
  readonly class: "small" | "bulk";
  /** Snaps of this class that failed since the daemon started. */
  readonly snapsFailed: number;
  /** The last snap's error, while the last snap failed; absent once one succeeds. */
  readonly lastSnapError?: string;
  /** When the current run of failed snaps began (Unix ms), while the last snap failed. */
  readonly snapFailingSinceUnixMs?: number;
}

/**
 * What the control plane last observed of a capture-sourced workspace's drain (the FINAL flush
 * and queue polling a stop runs before it removes the runtime). `draining`: the queue is still
 * moving. `kept`: nothing will stop the runtime, because its work is not confirmed saved —
 * `detail` says why. `saved`: the daemon confirmed its final flush complete. `gone`: the daemon
 * is silent and the runtime reports the executor ended.
 */
export interface WorkspaceCaptureDrain {
  /**
   * Also `stop-failed` (removing the runtime failed; retried), `stopped` (removed after its
   * drain), `discarded` (the owner discarded the unsaved captures; terminated without a drain).
   */
  readonly state: "draining" | "kept" | "saved" | "gone" | "stop-failed" | "stopped" | "discarded";
  readonly detail?: string;
  /** ISO-8601: when it was observed. */
  readonly observedAt?: string;
  /** ISO-8601: when the control plane starts (or started) the drain ahead of the deadline. */
  readonly preservationStartsAt?: string;
  /** The owner's request to discard the unsaved captures: who asked, and when (ISO-8601). */
  readonly discard?: { readonly requestedBy: string; readonly requestedAt: string };
  /**
   * The executor is RETAINED: kept because its disk holds work not confirmed saved (it ended
   * without a complete final flush, or its launch failed after it started). Recovery is attempted
   * on a backoff; `recoverable` says whether its runtime can restart it on its own disk (Docker)
   * or only report it (Kubernetes, MicroVM). `workspace.recover()` makes an attempt due now.
   */
  readonly retained?: {
    readonly since: string;
    readonly reason: string;
    readonly recoverable: boolean;
    readonly recoveryAttempts: number;
    readonly nextRecoveryAt?: string;
    readonly lastRecoveryError?: string;
  };
  /** The executor this observation is about (`resourceId` is what `completion` names). */
  readonly executor?: {
    readonly runId: string;
    readonly kind: string;
    readonly resourceId: string;
    readonly reference?: string;
    /** The launch identity the create named for this executor (`CreateOptions.launchId`). */
    readonly launchId?: string;
  };
  /** The latest completion attestation the control plane accepted for this executor. */
  readonly completion?: {
    readonly executorId: string;
    readonly epoch: number;
    readonly captureN: number;
    readonly attestedAt: string;
    /** The launch identity the attestation named. */
    readonly launchId?: string;
    /** When the store recorded the seal, when the attestation said. */
    readonly sealedAt?: string;
    /** Where in the executor's own history the seal was made, when the attestation said. */
    readonly origin?: WorkspaceCaptureOrigin;
  };
}

/**
 * The caller's attestation that its capture store holds a SEALED final capture of the workspace's
 * current executor (a FINAL flush that completed and was recorded durably by the store). See
 * `WorkspaceStopOptions.completion`.
 */
export interface WorkspaceCompletionAttestation {
  /** The sealed capture's chain position (`n`). */
  readonly captureN: number;
  /** The capture lease epoch the seal was made under. */
  readonly epoch: number;
  /**
   * The executor the seal names: the runtime's `resourceId` as `workspace.details().runtime`
   * reports it (its `reference`, or the run id, are accepted too).
   */
  readonly executorId: string;
  /**
   * The launch identity the seal names (`final_seal.executor`). Required when the create named a
   * `launchId` — and it must be that one; an attestation naming another launch, or none, is
   * ignored. A seal never transfers to another executor.
   */
  readonly launchId?: string;
  /** When the store recorded the seal (ISO 8601). Kept for display: clocks order nothing. */
  readonly sealedAt?: string;
  /**
   * Where in the executor's own history the seal was made (the `final_seal`'s stamp). The control
   * plane weighs the seal against its own observations of the executor by it: a report that the
   * work is not saved, made at or after the seal, revokes it (review 4 #1). Without it, any such
   * report at or past `captureN` does.
   */
  readonly origin?: WorkspaceCaptureOrigin;
}

/** Options for `workspace.stop()`. */
export interface WorkspaceStopOptions {
  /**
   * End the workspace WITHOUT saving its unsaved captures: no drain, the runtime is terminated
   * at once. The only way to end a capture-sourced workspace the control plane keeps because its
   * work cannot be confirmed saved. Recorded (who, when) and reported on the workspace's capture
   * drain as `discarded`. Owner only; irreversible — what was not saved is lost.
   */
  readonly discardUnsaved?: boolean;
  /**
   * Attest that your capture store holds a sealed final capture of this workspace's current
   * executor. It lets the control plane remove that executor's disk once it has ended even if it
   * never read `complete: true` from it itself (a lost FINAL reply, a daemon that exited before a
   * drain reached it). Accepted only when `executorId` names the current executor and `epoch` is
   * not older than any the executor reported; otherwise ignored (`completion.outcome` on the
   * result says which) and the executor is kept as before.
   */
  readonly completion?: WorkspaceCompletionAttestation;
}

/** What became of a `completion` attestation on `stop()`. */
export interface WorkspaceStopCompletion {
  readonly outcome: "accepted" | "ignored";
  /** Why it was ignored. */
  readonly detail?: string;
}

/**
 * What `workspace.recover()` did: `requested` — the workspace's executor is retained and a
 * recovery attempt is due now (`recoverable` says whether its runtime can restart it on its own
 * disk; if not, it is reported and kept); `not-retained` — nothing is retained, nothing was done.
 */
export interface WorkspaceRecoverResult {
  readonly state: "requested" | "not-retained";
  readonly recoverable?: boolean;
}

/**
 * What `workspace.stop()` observed — never more than was observed:
 *
 *  - `stopped`: the runtime is gone.
 *  - `requested`: the control plane accepted the stop, and the runtime is still up; nothing more
 *    has been observed yet. The stop continues on the server.
 *  - `draining`: the control plane is draining the workspace's unsaved captures (capture-sourced
 *    workspaces only) and the queue is still moving; the runtime is removed once the daemon
 *    confirms them saved.
 *  - `kept`: the control plane will NOT remove the runtime: its work is not confirmed saved
 *    (`drain.detail` says why). The workspace keeps running until it is — or, its executor having
 *    ended, it is retained (status `retained`) and recovered.
 *
 * `drain` is the control plane's last observation; `capture` is the daemon's queue as read now,
 * when it answers. Call `stop()` again to check (it is idempotent), or follow `status()`.
 */
export type WorkspaceStopResult = (
  | { readonly state: "stopped" }
  | {
      readonly state: "requested";
      readonly drain?: WorkspaceCaptureDrain;
      readonly capture?: WorkspaceCaptureStatus;
    }
  | {
      readonly state: "draining" | "kept";
      readonly drain: WorkspaceCaptureDrain;
      readonly capture?: WorkspaceCaptureStatus;
    }
) & {
  /** What became of `options.completion`, when one was sent. */
  readonly completion?: WorkspaceStopCompletion;
};

/** The daemon's answer to `workspace.capture.replan()` (sealantd 0.15 `capture.replan`). */
export interface WorkspaceCaptureReplanned {
  /** The worktree the session channel's plan answered; the executor captures under it from now on. */
  readonly worktreeId: string;
  /** The lease epoch the plan answered. */
  readonly epoch: number;
  /** The head sequence the plan carried, once the worktree has one. */
  readonly headN?: number;
  /** The head capture the plan carried, once the worktree has one. */
  readonly headCaptureId?: string;
  /** What the delta materialise wrote: files whose bytes, mode or links differed from disk. */
  readonly filesWritten: number;
  readonly bytesWritten: number;
  /** What it left alone: files already matching the plan on disk. */
  readonly filesSkipped: number;
  readonly bytesSkipped: number;
  /** Files, symlinks and emptied directories the plan dropped, swept from the tree. */
  readonly removed: number;
  /** The plan named the worktree and epoch already in force; nothing moved. */
  readonly unchanged: boolean;
}

/** Options for `workspace.capture.flush()`: which flush the daemon runs, and its bounds. */
export interface WorkspaceCaptureFlushOptions {
  /**
   * `final`: the executor is ending. The daemon stops its managed processes, snapshots both
   * capture classes, ships, reports `complete`, and refuses new work from then on. `suspend`
   * (the default): a checkpoint; the executor keeps running.
   */
  readonly kind?: "final" | "suspend";
  /**
   * How long the daemon may take before it answers, in milliseconds (a positive integer). A final
   * flush past its deadline answers `complete: false` and keeps shipping in the daemon, so later
   * `status()` reads and repeated final flushes converge. Absent: the daemon's default.
   */
  readonly deadlineMs?: number;
  /**
   * Final only: how long managed processes get between SIGTERM and SIGKILL, in milliseconds (a
   * positive integer), counted inside `deadlineMs`. Absent: the daemon's default.
   */
  readonly graceMs?: number;
}

/** Capture operations of a capture-sourced workspace. */
export interface WorkspaceCapture {
  /**
   * Capture, then ship and register everything staged. Synchronous: resolves once the daemon has
   * flushed, bounded by `options.deadlineMs`. Pass `{ kind: "final" }` before letting the
   * executor go away, and gate its retirement on `complete === true`. Refused on workspaces that
   * are not capture-sourced.
   */
  flush(options?: WorkspaceCaptureFlushOptions): Promise<WorkspaceCaptureStatus>;
  /**
   * The daemon's capture queue as it stands, nothing flushed: `pending` captures not yet saved,
   * `headN` / `registered` what the session channel holds, `refused` what the quota turned away.
   * What a drain polls to show `saving · N left`. Refused on workspaces that are not
   * capture-sourced, and when no runtime answers.
   */
  status(): Promise<WorkspaceCaptureStatus>;
  /**
   * Re-plan: the daemon asks the session channel for its plan again with no worktree named,
   * delta-materialises the answer over what is on disk, and captures under the answered worktree
   * and epoch from then on (the fence lifts, foreign queue entries drop). The claim hook for a
   * standby executor. Synchronous and idempotent (`unchanged: true`). Refused on workspaces that
   * are not capture-sourced.
   */
  replan(): Promise<WorkspaceCaptureReplanned>;
}

/** How a dotfiles tree is applied inside the workspace. */
export type WorkspaceDotfilesManager = "auto" | "chezmoi" | "stow" | "copy";

/**
 * A dotfiles repository the platform clones and applies before the workspace accepts work. Public
 * or GitHub-App-reachable repos work as-is; for a repo only the caller's own ssh identity can
 * reach, resolve it host-side and send the checkout as an archive instead (see
 * `WorkspaceDotfilesArchive`).
 */
export interface WorkspaceDotfilesRepository {
  /** Clone URL (or `"github.com/acme/dotfiles"` shorthand). */
  readonly url: string;
  /** Git ref. Omitted = the remote's default branch — never assumed to be `main`. */
  readonly ref?: string;
  /** Defaults to `"auto"`: chezmoi/stow layouts are detected, everything else is copied. */
  readonly manager?: WorkspaceDotfilesManager;
  /** Run the repo's bootstrap command after applying (skipped when absent). Defaults to true. */
  readonly bootstrap?: boolean;
  /** Bootstrap command, relative to the checkout. Defaults to `./install.sh`. */
  readonly bootstrapCommand?: string;
}

/**
 * A caller-resolved dotfiles tree: a gzipped tar the daemon extracts and applies at boot through
 * the same manager dispatch as a cloned repo. This is the shape for dotfiles resolved host-side —
 * a checkout cloned with the caller's own ssh identity, or a scanned selection of home files —
 * so no URL or credential ever has to reach the workspace. Max 4 archives, ~4MB decoded each.
 */
export interface WorkspaceDotfilesArchive {
  /** base64 of a `.tar.gz` whose contents apply relative to the target. */
  readonly data: string;
  /** Defaults to `"auto"`. Scanned home files usually want `"copy"`. */
  readonly manager?: WorkspaceDotfilesManager;
  /** Where the tree lands: `"home"` (default) or `"config"` (`$HOME/.config`, copy manager only). */
  readonly target?: "home" | "config";
  /** Run `./install.sh` (or `bootstrapCommand`) after applying when present. Defaults to true. */
  readonly bootstrap?: boolean;
  readonly bootstrapCommand?: string;
}

/**
 * Dotfiles for the workspace: a repository the platform clones, caller-resolved archives, or both
 * (the repository applies first, archives after — in order — so local selections override repo
 * files). Applied before the workspace reports ready; a failing apply fails the launch loudly.
 * Not supported with `baseImage` (custom bases guarantee only a POSIX shell).
 */
export interface WorkspaceDotfilesOptions {
  readonly repository?: WorkspaceDotfilesRepository;
  readonly archives?: readonly WorkspaceDotfilesArchive[];
}

/** Runtime-managed services attached only to this workspace. */
export interface WorkspaceServicesOptions {
  /**
   * Give the workspace a Docker client connected to its own disposable daemon. The platform never
   * mounts the host Docker socket.
   */
  readonly docker?: boolean;
}

/** One cluster env source: a Kubernetes object whose keys become workspace environment. */
export interface WorkspaceEnvFromSource {
  readonly kind: "secret" | "configmap";
  /** Kubernetes object name (DNS-1123 subdomain) in the platform's workspaces namespace. */
  readonly name: string;
}

export interface CreateOptions {
  /**
   * Source git repository to build the workspace around (e.g. `"github.com/acme/billing-service"`).
   * Exactly one of `repository` or `source` must be provided.
   */
  readonly repository?: string;
  /**
   * Alternative to `repository`: source the workspace from a caller-owned mount, a standby root,
   * or a capture channel (see each source type).
   */
  readonly source?: WorkspaceMountSource | WorkspaceStandbySource | WorkspaceCaptureSource;
  /** Additional read-only-by-default mounts beside the primary source (see `WorkspaceExtraMount`). */
  readonly mounts?: readonly WorkspaceExtraMount[];
  /** The harness to run inside the workspace. */
  readonly harness: Harness;
  /** Git ref to check out (defaults to the repository's default branch; `repository` only). */
  readonly ref?: string;
  /** Human-friendly name for the workspace. */
  readonly name?: string;
  /** OS family for the workspace image. Mutually exclusive with `baseImage`. */
  readonly os?: WorkspaceOs;
  /**
   * Build the workspace image FROM this arbitrary OCI image reference instead of a managed OS
   * family (e.g. `"node:22-bookworm"`). Distro package installs are skipped; the build overlays
   * only the sealantd supervisor, the harness CLIs (npm), and a static socat relay. See "Custom
   * base images" in the SDK README for the base-image contract. Mutually exclusive with `os`;
   * `packages` install through the base's own package manager (apt/apk/dnf/pacman) and fail the
   * build readable when it has none.
   */
  readonly baseImage?: string;
  /** Extra OS packages to install in the workspace. */
  readonly packages?: readonly string[];
  /**
   * Login shell for the workspace user (`"bash"` default). The shell package is installed and the
   * login shell switched, so dotfiles like `.zshrc` actually take effect. Managed OS families
   * only — custom bases guarantee just a POSIX shell.
   */
  readonly shell?: "bash" | "zsh" | "fish";
  /** Dotfiles applied before the workspace accepts work (see `WorkspaceDotfilesOptions`). */
  readonly dotfiles?: WorkspaceDotfilesOptions;
  /**
   * Ordinary (non-secret) environment variables set on the workspace container and inherited by
   * every process the platform starts inside it — the harness, later shells, exec'd commands, and
   * their descendants. Validated client-side against the public policy re-exported from this
   * package (`parseWorkspaceEnv`): names are `[A-Za-z_][A-Za-z0-9_]*`, platform-owned and
   * secret-looking names are rejected loudly (the workspace runtime filters names containing
   * `TOKEN`/`SECRET`/`PASSWORD`/`PASSWD`/`CREDENTIAL`/`APIKEY`, ending in `_KEY`, or exactly
   * `KEY` — a value under such a name would silently never arrive). Not for secrets: values are
   * persisted verbatim in the durable workspace spec and returned by workspace-details APIs; use
   * `credentials` for connected-account material. The map is fixed at creation — a live workspace
   * is never mutated, and a platform-side restart reuses the stored spec. Containers started
   * INSIDE the workspace by Docker Compose or `docker run` receive only what the Compose file or
   * command explicitly passes. Docker runtime only.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * SECRET environment variables for the workspace — API keys, database URLs with passwords,
   * anything a dev server needs that must not be persisted or echoed. Same grammar and size
   * bounds as `env`, validated client-side by `parseWorkspaceSecretEnv`; secret-shaped names are
   * exactly what belongs here, while platform-owned names and connected-account names
   * (`GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) stay reserved. Delivered through the transient
   * secret channel: encrypted at rest on the build job until launch, handed to the workspace
   * daemon as a boot file that is removed once the workspace is ready, never written to the
   * blueprint, the attempt snapshot, `docker inspect`, or any read API — and every value is
   * masked in captured process output. Inherited by every process the platform starts in the
   * workspace, winning over `env` and container env for the same name. Fixed at creation; a
   * platform-side RESTART of the workspace runs without secret env (create a new workspace
   * instead). Docker runtime only.
   */
  readonly secretEnv?: Readonly<Record<string, string>>;
  /**
   * Cluster env sources — Kubernetes runtimes only. Each entry names one Kubernetes `Secret` or
   * `ConfigMap` in the platform's workspaces namespace whose KEYS become workspace environment,
   * resolved by the platform worker at workspace creation (a launch keeps its snapshot across
   * container restarts; rotation reaches only later launches). Ordered, last wins across kinds.
   * Only objects the operator opted in with the `sealant.sh/workspace-env: "true"` label
   * resolve; platform-managed objects are refused unconditionally. Explicit `env` / `secretEnv`
   * and platform-owned names always win over bound keys; bound Secret values ride the transient
   * secret channel and are masked in captured output. On a deployment whose workspaces do not
   * run on Kubernetes, create is refused synchronously with the stable error code
   * `runtime-env-references-unsupported` — no workspace is created.
   */
  readonly envFrom?: readonly WorkspaceEnvFromSource[];
  /**
   * Kubernetes-runtime-only settings. `serviceAccountName` is an explicit TRUST GRANT: the
   * workspace Pod runs under it, and with IRSA / Workload Identity the session agent holds that
   * role's full permissions for the whole session — bind a least-privilege role intended for
   * untrusted code. Honored only against the install's allowlist
   * (`SEALANT_K8S_ALLOWED_WORKSPACE_SERVICE_ACCOUNTS`); other names fail the launch readable.
   * The Kubernetes API token is never automounted regardless. Non-Kubernetes deployments refuse
   * at create time with `runtime-env-references-unsupported`.
   */
  readonly kubernetes?: {
    readonly serviceAccountName?: string;
  };
  /** Runtime-managed services that need more than installing an OS package. */
  readonly services?: WorkspaceServicesOptions;
  /** When true (default), resolve only once the workspace runtime is live. */
  readonly wait?: boolean;
  /** Observe provisioning events as they happen. */
  readonly onEvent?: (event: WorkspaceEvent) => void;
  /** Connected-account credentials to attach to the workspace (see `WorkspaceCredentialsOptions`). */
  readonly credentials?: WorkspaceCredentialsOptions;
  /**
   * Write the launch's logins into this home instead of `$HOME` and the environment: Claude and
   * Codex as their credential files, GitHub as `<home>/.config/gh/hosts.yml` (no `GITHUB_TOKEN`
   * or `GH_TOKEN`), every file owned by `uid`:`gid`, mode 0600. The home may not exist yet (a
   * per-person user is made after the launch): the launch makes it, owned by `uid`:`gid`, mode
   * 0700. The home is then held for the workspace's owner, as `workspace.credentials.put` would
   * hold it, and kept refreshed. Absolute, normalised, never under `/workspace`. No extra call:
   * the logins are written by the launch itself.
   */
  readonly credentialsHome?: WorkspaceCredentialsHomeOptions;
  /**
   * Time-to-live for the workspace, e.g. `"90m"`, `"2h"` (also `"45s"`, `"1d"`). Once it elapses
   * the platform stops the workspace and removes its container. Omitted = the server default TTL
   * (if the install configures one).
   */
  readonly ttl?: string;
  /**
   * Makes `create()` idempotent for this client's owner: a repeated create with the same key
   * returns the workspace the first one made (`workspace.launch?.replayed` is `true`) instead of
   * creating another. A caller that lost a create's answer (a crash, a timeout) repeats it, or
   * finds the workspace with `workspaces.findByIdempotencyKey(key)`. `workspaces.createState(key)`
   * says what became of the create (`pending`, `found`, `cancelled`, `none`), and
   * `workspaces.cancelCreate(key)` makes sure a create with the key never launches — a delayed
   * original request included.
   */
  readonly idempotencyKey?: string;
  /**
   * Your immutable identity for the ONE executor this create launches, minted before create (an
   * idempotency key, unique per launch attempt, serves). Recorded with the launch and reported as
   * `runtime.launchId`; a `stop({ completion })` about this executor must name it.
   */
  readonly launchId?: string;
}

/**
 * What became of an idempotent create, by its key:
 *
 *  - `pending`: a create with the key started and has not committed (in flight, or it died first).
 *    Repeat the create to finish it, or `cancelCreate` to make sure it never launches.
 *  - `found`: it committed; `workspaceId` / `runId` / `launchId` name what it made.
 *  - `cancelled`: the key was cancelled; no create with it launches.
 *  - `none`: no create with the key has reached the control plane — as of now only; a delayed
 *    request can still arrive. `cancelCreate` is the answer that stays true.
 */
export interface WorkspaceCreateState {
  readonly idempotencyKey: string;
  readonly state: "pending" | "found" | "cancelled" | "none";
  readonly workspaceId?: string;
  readonly runId?: string;
  readonly launchId?: string;
}

/**
 * The executor a workspace runs on, as the control plane recorded it. `resourceId` is the id to
 * record at launch and to name in `stop({ completion })`.
 */
export interface WorkspaceRuntimeInfo {
  /** The runtime family: `docker`, `k8s`, `k3s`, `cloudflare` or `microvm`. */
  readonly kind: "docker" | "k8s" | "k3s" | "cloudflare" | "microvm";
  /** The executor's id on its runtime: the container id, the Pod name, the MicroVM id. */
  readonly resourceId: string;
  /** The runtime's name for it (container name, Pod name, MicroVM id). */
  readonly reference: string;
  /** `retained`: kept with its disk for recovery (see `WorkspaceStatus`). */
  readonly status: "pending" | "running" | "ready" | "failed" | "stopped" | "retained";
  /** The run (launch attempt) the executor belongs to, when the control plane reports it. */
  readonly runId?: string;
  /** The launch identity the create named for this executor (`CreateOptions.launchId`). */
  readonly launchId?: string;
  /** ISO-8601 instant the runtime ends it on its own; `null` where there is no such cap. */
  readonly deadline: string | null;
}

/** What a handle knows of the launch that made it (`workspaces.create()`). */
export interface WorkspaceLaunch {
  /** The launch attempt the create started (a replayed create: the workspace's latest). */
  readonly runId?: string;
  /**
   * The executor: known on a replayed create when one exists, and filled in when `ready()`
   * resolves (the executor that became ready).
   */
  readonly runtime?: WorkspaceRuntimeInfo;
  /** An earlier create with the same `idempotencyKey` made this workspace. */
  readonly replayed: boolean;
  /** The launch identity the create named. */
  readonly launchId?: string;
  /** The image the executor booted, with its per-person capability; filled in by `ready()`. */
  readonly image?: WorkspaceImage;
}

export interface ListOptions {
  readonly status?: WorkspaceStatus;
  readonly limit?: number;
}

/** Options for a deterministic `workspace.exec()`. */
export interface WorkspaceExecOptions {
  /** Working directory inside the workspace (defaults to the repository root). */
  readonly cwd?: string;
  /**
   * Run the process as this Linux user: a user name of the image's passwd, or a numeric uid. It
   * takes its uid, gid, supplementary groups and `HOME`, `USER`, `LOGNAME` and `SHELL` from the
   * passwd entry, with umask 0002. Never run as anyone else in its place: the SDK sends it only to a
   * control plane that reports the feature (read once per client), and rejects with code
   * `user-unsupported` otherwise; a control plane that reports it but whose runtime cannot do it
   * yet (no released sealantd can) rejects with `WorkspaceConflictError` / `SessionConflictError`,
   * body code `user-unsupported`. Nothing is started either way.
   */
  readonly user?: string;
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
  /**
   * When the runtime itself ends this workspace's executor, whatever anyone asks: an ISO-8601
   * instant (a Lambda MicroVM's maximum duration from its start), or `null` where the runtime
   * imposes no lifetime (Docker, Kubernetes) or no runtime is launched yet. Work that exists only
   * on the executor — a capture-sourced workspace's unsaved captures — must be drained before it.
   */
  runtimeDeadline(): Promise<string | null>;
  /**
   * The workspace's current executor, read now: its runtime kind, `resourceId`, `reference`,
   * run and deadline. `null` while no runtime is launched yet.
   */
  runtime(): Promise<WorkspaceRuntimeInfo | null>;
  /** The image the workspace's latest launch booted, with its per-person capability. */
  image(): Promise<WorkspaceImage | null>;
  /**
   * What this handle knows of the launch that made it (from `workspaces.create()`), including the
   * executor `ready()` saw become ready. `undefined` on handles from `get()` / `list()`.
   */
  readonly launch: WorkspaceLaunch | undefined;
  /**
   * Resolves once the workspace runtime is live and ready to accept a run. When the handle came
   * from `workspaces.create()` and readiness times out (`workspace_ready_timeout`), a stop is
   * requested before the error is thrown, so an abandoned launch does not keep running to its
   * cap; the error says whether the request was accepted (not that the workspace stopped).
   */
  ready(): Promise<this>;
  /** Run a harness in this workspace. */
  readonly harness: HarnessRunner;
  /**
   * Execute one command deterministically in the workspace — no agent in the loop — recorded into a
   * run record like any other process. `argv[0]` is the executable, the rest its arguments.
   */
  exec(argv: readonly string[], options?: WorkspaceExecOptions): Promise<WorkspaceExecResult>;
  /**
   * Point a standby working directory, or a bindable extra mount, at one subdirectory of its root
   * (sealantd ADR-0014). Synchronous: resolves once the daemon applied it. Returns every live
   * binding, which each relaunch re-applies.
   */
  bind(options: WorkspaceBindOptions): Promise<readonly WorkspaceBind[]>;
  /** Capture flush for capture-sourced workspaces (sealantd ADR-0015). */
  readonly capture: WorkspaceCapture;
  /** Interactive PTY sessions: open new ones, reattach to existing ones by id. */
  readonly sessions: WorkspaceSessions;
  /** Lifecycle events as an async stream. */
  events(): AsyncIterable<WorkspaceEvent>;
  /**
   * Stop the workspace: remove its runtime and settle it in the terminal "stopped" status.
   * Resolves `{ state: "stopped" }` once the runtime is observed gone. A capture-sourced
   * workspace is drained first (its unsaved captures shipped and confirmed saved), which can take
   * minutes; if the runtime is still up after a minute, resolves with what was observed instead:
   * `draining`, `kept` (the workspace keeps running because its work is not confirmed saved), or
   * `requested` (accepted, nothing more observed yet). Never reports a stop it did not observe.
   * `{ discardUnsaved: true }` ends it without saving its unsaved captures (see
   * `WorkspaceStopOptions`).
   */
  stop(options?: WorkspaceStopOptions): Promise<WorkspaceStopResult>;
  /**
   * Ask the control plane to recover this workspace's RETAINED executor now — one kept because
   * its disk holds work not confirmed saved. Where the runtime can (Docker) it is restarted on
   * its own disk, drained with a final flush, and only then removed; elsewhere it is reported and
   * kept. Resolves once the request is recorded; follow `details().captureDrain`.
   */
  recover(): Promise<WorkspaceRecoverResult>;
  /**
   * What the control plane last observed of this workspace's capture drain and retention, read
   * without stopping anything: the drain state and detail, whether the executor is RETAINED (and
   * how its recovery is going), the completion attestation it accepted, and the executor it is
   * about (runtime identity and launch identity). `null` when nothing was observed yet, or from a
   * control plane that predates it — which says nothing about whether the work is saved.
   */
  captureDrain(): Promise<WorkspaceCaptureDrain | null>;
  /** Restart the workspace into a fresh runtime — a new container, no filesystem carry-over. */
  restart(): Promise<Workspace>;
  /**
   * People's logins in this RUNNING workspace, one person per home (a person's home, a
   * conversation home, or `/root`). Needs a service key.
   */
  readonly credentials: WorkspaceCredentials;
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

/**
 * One person's logins in the homes of a running workspace (see {@link Workspace.credentials}). A
 * home holds one person's logins while it is held: the first `put` names its person and a `put` for
 * anyone else is refused (`WorkspaceConflictError`, code `home-held`) until the home is released.
 * Core writes a copy of each account (no refresh token, as at launch) owned by the home's owner,
 * mode 0600, and keeps it refreshed there; GitHub is written as `<home>/.config/gh/hosts.yml`.
 */
export interface WorkspaceCredentials {
  /**
   * Put `onBehalfOf`'s logins into `home`, which must exist (its owner owns the files). Resolves
   * with the home as it is afterwards. Rejects with `WorkspaceConflictError` and a body `code`:
   * `home-held` (another person's home; `/root` for anyone but the owner), `home-unusable`
   * (missing, not a directory, reached through a symbolic link, or a login directory linking out
   * of it), `home-busy` (another write into it is still running: retry), `workspace-not-running`,
   * `connected-account-invalid`; with
   * `WorkspaceNotFoundError` for an account `onBehalfOf` cannot name; with
   * `WorkspaceBadGatewayError` when the executor did not confirm the write.
   */
  put(options: WorkspaceCredentialsPutOptions): Promise<WorkspaceCredentialHome>;
  /**
   * Release `home`: its login files are removed and its record deleted, so the home can be taken
   * again. Idempotent: `released` is `false` when it held nothing.
   */
  release(home: string): Promise<{ readonly released: boolean }>;
  /** The homes of the running executor and the logins Core keeps in each, oldest first. */
  list(): Promise<readonly WorkspaceCredentialHome[]>;
}

/**
 * A provider's account for {@link WorkspaceCredentials.put}: `true` for `onBehalfOf`'s default
 * account, a string naming one (name or id), `null` to remove that provider's login from the home
 * (the person has not connected it); `false` or absent leaves the provider as it is.
 */
export type WorkspaceCredentialsAccountChoice = boolean | string | null;

/** Options for {@link WorkspaceCredentials.put}. */
export interface WorkspaceCredentialsPutOptions {
  /** Absolute path of the home inside the executor; never under `/workspace`. */
  readonly home: string;
  /**
   * The Sealant user whose logins the home holds (their `userId`). The workspace stays the
   * client's owner's; only a service key may name someone else.
   */
  readonly onBehalfOf: string;
  /**
   * The home's owner, given together: a home that does not exist yet is made for them (0700, from
   * `/etc/skel`), so a put can run beside the `useradd` that makes the user. Without them a missing
   * home is refused (`home-unusable`).
   */
  readonly uid?: number;
  readonly gid?: number;
  readonly claude?: WorkspaceCredentialsAccountChoice;
  readonly codex?: WorkspaceCredentialsAccountChoice;
  readonly github?: WorkspaceCredentialsAccountChoice;
}

/** One account whose copy a home holds. */
export interface WorkspaceCredentialHomeAccount {
  readonly connectedAccountId: string;
  /** The account's name under its provider, as it is now. */
  readonly name: string;
}

/** One home of a running workspace and the logins Core keeps in it. */
export interface WorkspaceCredentialHome {
  readonly home: string;
  /** The one person whose logins the home holds. */
  readonly onBehalfOf: string;
  readonly accounts: {
    readonly claude?: WorkspaceCredentialHomeAccount;
    readonly codex?: WorkspaceCredentialHomeAccount;
    readonly github?: WorkspaceCredentialHomeAccount;
  };
}

/**
 * Whether an image can run Mend's per-person layout on the deployment's runtime: its sealantd runs
 * processes and dotfiles as a user and restores owners, it has `sudo`, `useradd` and `setfacl`, no
 * user or group in 40000–49999 but `mend`, it is not a nix image, and the runtime's `/workspace`
 * takes ACLs. What is not known is `unknown`, never `supported`.
 */
export interface WorkspaceImagePersonLayout {
  readonly status: "supported" | "unsupported" | "unknown";
  /** Stable codes of what the image or the runtime lacks (`setuid-sudo`, `setpriv`, `acl`, …). */
  readonly missing: readonly string[];
  /** What could not be read (`probe`, `sealantd`, `flock`, `acl`). */
  readonly unknown: readonly string[];
  /** The runtime the answer is for: the deployment's default adapter. */
  readonly runtime: string;
  /** ACLs on that runtime's `/workspace`, as the operator declared them. */
  readonly acl: "supported" | "unsupported" | "unknown";
}

/** A published workspace image. */
export interface WorkspaceImage {
  readonly reference: string;
  readonly digestReference: string;
  readonly digest: string;
  /** Absent from control planes before the per-person capability. */
  readonly personLayout?: WorkspaceImagePersonLayout;
}

/** What a create would build, read before it (see `workspaces.inspectImage`). */
export interface WorkspaceImageInspection {
  /** `workspaces.imageKey(options)`: the key to keep the answer under. */
  readonly imageKey: string;
  /** The hash of the image plan: one per distinct build input. */
  readonly planHash: string;
  /** The latest image published for the plan, when this owner has built one. */
  readonly image?: WorkspaceImage;
  /** The image's per-person capability (`unknown` when none has been built yet). */
  readonly personLayout: WorkspaceImagePersonLayout;
}

/** Where a launch writes its logins (see {@link CreateOptions.credentialsHome}). */
export interface WorkspaceCredentialsHomeOptions {
  /** Absolute path of the home inside the executor, e.g. `/home/m4lice000`. */
  readonly path: string;
  /** The home's owner: the uid its user will have. */
  readonly uid: number;
  /** The owner's group. */
  readonly gid: number;
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
/**
 * How a session's leader is wired. `pty` (default) allocates a pseudoterminal — interactive
 * shells and TUIs. `pipe` gives the leader plain stdio pipes and no tty — the shape for processes
 * that speak a byte protocol over stdin/stdout (JSON-RPC / NDJSON servers such as
 * `codex app-server`): `send` feeds stdin, `output`/`attach` carry stdout byte-exact, stderr is
 * recorded as diagnostics only, and `resize` is rejected.
 */
export type SessionMode = "pty" | "pipe";

export interface SessionOptions {
  /** Working directory inside the workspace (defaults to the repository root). */
  readonly cwd?: string;
  /** Extra environment for the session process (not for secrets — use `credentials`). */
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
  readonly term?: string;
  /** Leader wiring; defaults to `pty`. `cols`/`rows`/`term` are ignored for `pipe`. */
  readonly mode?: SessionMode;
  /** Opaque correlation bag, stored verbatim and echoed on reads. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Run the process as this Linux user: a user name of the image's passwd, or a numeric uid. It
   * takes its uid, gid, supplementary groups and `HOME`, `USER`, `LOGNAME` and `SHELL` from the
   * passwd entry, with umask 0002. Never run as anyone else in its place: the SDK sends it only to a
   * control plane that reports the feature (read once per client), and rejects with code
   * `user-unsupported` otherwise; a control plane that reports it but whose runtime cannot do it
   * yet (no released sealantd can) rejects with `WorkspaceConflictError` / `SessionConflictError`,
   * body code `user-unsupported`. Nothing is started either way.
   */
  readonly user?: string;
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
  /**
   * Whether the run's changes were read. `false`: they were not (the run has not ended, or the
   * reading failed), and the empty `files` and `diff` say nothing about what changed.
   */
  readonly available?: boolean;
  /** Why the changes are not available, when `available` is `false`. */
  readonly unavailableReason?: string;
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
  /** Leader wiring: a pseudoterminal or plain stdio pipes. */
  readonly mode: SessionMode;
  /** Send input: keystrokes to a PTY, bytes to a pipe leader's stdin. Strings are UTF-8-encoded. */
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
  /** Resize the PTY. Rejected for `pipe` sessions, which have no terminal. */
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
 * Selecting both providers in one exchange is ambiguous and rejected; a profile-only selection
 * prefers the profile's claude binding and falls back to its codex binding. SECURITY: only
 * account references cross this surface — never token material.
 */
export interface InferenceCredentialsOptions {
  /** Profile id whose claude (else codex) binding applies when neither is set explicitly. */
  readonly profile?: string;
  /** `true` for the caller's default claude account, or a string naming a specific one. */
  readonly claude?: boolean | string;
  /**
   * `true` for the caller's default codex account, or a string naming a specific one. Codex
   * exchanges are tool-less today: caller-defined `tools` are rejected, and the exchange settles
   * in a single turn.
   */
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

// ---------------------------------------------------------------------------------------------
// Users (service principals acting on behalf of their own users)
// ---------------------------------------------------------------------------------------------

export interface SealantUser {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface EnsureUserOptions {
  readonly email: string;
  readonly name: string;
  /** Caller-chosen id for a NEW user; ignored when the email already exists. */
  readonly userId?: string;
}

export interface EnsuredUser extends SealantUser {
  /** True when this call created the user. */
  readonly created: boolean;
}

/**
 * Identity rows for products that own their own login. `ensure` is idempotent on email: call it on
 * every sign-in and build the per-user client with the returned `userId` as `ownerUserId`.
 */
export interface UsersNamespace {
  ensure(options: EnsureUserOptions): Promise<EnsuredUser>;
  get(userId: string): Promise<SealantUser>;
}

// ---------------------------------------------------------------------------------------------
// Connected accounts (the client's owner's Claude / Codex / GitHub credentials)
// ---------------------------------------------------------------------------------------------

export type ConnectedAccountProvider = "claude" | "codex" | "github";
export type ConnectedAccountStatus = "active" | "invalid" | "archived";

/** A connected account as every surface sees it — NEVER carries secret material. */
/**
 * What the control plane observed about a credential's life. Null means nothing was observed: a
 * setup token has no expiry, an account connected before this shipped has no stored one, and an
 * account never swept has no refresh outcome. Read it to report freshness; never to decide that a
 * credential works, which only using it establishes.
 */
export interface ConnectedAccountCredential {
  readonly accessExpiresAt: string | null;
  readonly refreshExpiresAt: string | null;
  readonly lastRefreshAt: string | null;
  readonly lastRefreshOutcome: "refreshed" | "fresh" | "failed" | null;
}

export interface ConnectedAccount {
  readonly connectedAccountId: string;
  readonly ownerUserId: string;
  readonly provider: ConnectedAccountProvider;
  readonly name: string;
  /** Provider-shaped payload kind: oauth-token | credentials-json | auth-json | gh-cli-token. */
  readonly kind: string;
  readonly status: ConnectedAccountStatus;
  /** Non-secret display data (token suffix, codex account email, github login + scopes). */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly connectedAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly credential: ConnectedAccountCredential;
}

export interface ConnectConnectedAccountOptions {
  readonly provider: ConnectedAccountProvider;
  /**
   * Provider-shaped plaintext, passed through and sealed server-side: a Claude setup token or
   * verbatim `.credentials.json`, verbatim Codex `auth.json`, or a GitHub token. Never logged.
   */
  readonly secret: string;
  /** Account name under the provider; defaults to `default` (the one `credentials: { x: true }` picks). */
  readonly name?: string;
}

/**
 * The owner's connected provider accounts. `connect` upserts on (provider, name), so reconnecting
 * swaps the sealed credential in place. Secrets flow one way — in; no call returns them.
 */
export interface ConnectedAccountsNamespace {
  list(): Promise<readonly ConnectedAccount[]>;
  connect(options: ConnectConnectedAccountOptions): Promise<ConnectedAccount>;
  /** Soft-archives the account; uniform not-found for "does not exist" and "not yours". */
  disconnect(connectedAccountId: string): Promise<ConnectedAccount>;
}

// ---------------------------------------------------------------------------------------------
// Workspace SSH (how an editor or plain `ssh` reaches a workspace through the gateway)
// ---------------------------------------------------------------------------------------------

/** Connect coordinates for the deployment's workspace SSH gateway. */
export interface WorkspaceSshInfo {
  readonly host: string;
  readonly port: number;
  /** The SSH username is `<usernamePrefix>-<workspaceId>`; the key names the account. */
  readonly usernamePrefix: string;
}

/**
 * Where workspace SSH connects for this deployment. Consumers build the destination
 * `<usernamePrefix>-<workspaceId>@<host>:<port>` themselves — nothing here is secret; the
 * gateway authorizes each connection from the offered key's owning account.
 */
export interface WorkspaceSshNamespace {
  /** Gateway connect coordinates, or null when the deployment exposes no workspace SSH gateway. */
  info(): Promise<WorkspaceSshInfo | null>;
}

/** A registered SSH public key as every surface sees it — never carries the key material back. */
export interface SshKey {
  readonly sshKeyId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly createdAt: string;
}

export interface EnsureSshKeyOptions {
  /** Raw `<algorithm> <base64> [comment]` line; normalized and fingerprinted server-side. */
  readonly publicKey: string;
  /** Display name; defaults to the key comment, else `<algorithm> <fingerprint prefix>`. */
  readonly name?: string;
}

/**
 * The owner's SSH public keys — what the workspace SSH gateway resolves a connection to.
 * `ensure` is idempotent per owner: re-offering the same key returns the existing row; a key
 * active on another account is refused (active fingerprints are globally unique).
 */
export interface SshKeysNamespace {
  ensure(options: EnsureSshKeyOptions): Promise<SshKey>;
  list(): Promise<readonly SshKey[]>;
  /** Archives the key; the gateway stops resolving it. */
  remove(sshKeyId: string): Promise<SshKey>;
}
