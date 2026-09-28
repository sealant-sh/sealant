/**
 * The capture workspace source (sealantd ADR-0015), as every runtime adapter delivers it.
 *
 * A capture-sourced workspace mounts nothing and clones nothing: `sealantd boot` reads the
 * session channel address from the environment, fetches the worktree's head plan, materialises it
 * onto the executor's own disk, claims the lease and ships captures back over the channel. The
 * adapters own exactly two things here — the non-secret boot facts below, and the delivery of the
 * session credential through the existing secret env channel (`SEALANT_SECRET_ENV_FILE`), where it
 * arrives as `SEALANT_CAPTURE_TOKEN` and seeds the daemon's redactor like any other secret.
 */
import type { RuntimeAdapterLaunchInput } from "./runtime-adapter.js";

export type CaptureWorkspaceSource = Extract<
  RuntimeAdapterLaunchInput["blueprint"]["sources"]["workspace"],
  { kind: "capture" }
>;

/** The daemon's name for the session channel address. */
export const CAPTURE_ENDPOINT_ENV = "SEALANT_CAPTURE_ENDPOINT";
/**
 * The worktree the daemon materialises and keys its captures under (`captures/<worktree>/…`).
 * Left unset for a standby executor (no worktree yet): the daemon then takes the id from the
 * channel's plan answer, which names the worktree it is bound to at claim.
 */
export const CAPTURE_WORKTREE_ID_ENV = "SEALANT_CAPTURE_WORKTREE_ID";
/** The executor-local directory the daemon captures and restores as harness state. */
export const CAPTURE_HARNESS_HOME_ENV = "SEALANT_CAPTURE_HARNESS_HOME";

/** The launcher's statement that the network to the channel is private: plain HTTP is dialled. */
export const CAPTURE_ALLOW_PLAINTEXT_ENV = "SEALANT_CAPTURE_ALLOW_PLAINTEXT";
/** PEM roots the channel's certificate must chain to, in place of the public roots. */
export const CAPTURE_CA_PEM_ENV = "SEALANT_CAPTURE_CA_PEM";
/** PEM roots presigned object URLs must chain to, in place of the public roots. */
export const CAPTURE_OBJECT_CA_PEM_ENV = "SEALANT_CAPTURE_OBJECT_CA_PEM";

/**
 * How long a shutdown's final capture flush (`SIGTERM`) may take before the daemon stops trying
 * and exits 75 with its staging kept (sealantd e2e 5). Unset, a final flush that cannot finish —
 * a store that is down — retries until the runtime's stop grace ends and SIGKILL lands: the exit
 * that says "not saved, keep my disk" is never reached.
 */
export const SHUTDOWN_FINAL_DEADLINE_ENV = "SEALANT_SHUTDOWN_FINAL_DEADLINE_MS";

/**
 * sealantd's own shutdown grace (SIGTERM → SIGKILL for its managed processes) when the boot names
 * none; Core never sets `SEALANT_SHUTDOWN_GRACE_MS`. The final flush's deadline is kept at or
 * above it: the processes get their grace before anything is snapped.
 */
const DAEMON_SHUTDOWN_GRACE_MS = 10_000;

/**
 * The shutdown final flush's deadline for an executor whose runtime waits `stopGraceMs` after
 * `SIGTERM` before it kills it (Docker `--stop-timeout`, a Pod's `terminationGracePeriodSeconds`,
 * a MicroVM's terminate-hook budget): the grace less a margin (a tenth, between 5 s and 60 s) in
 * which the daemon writes its state and exits 75 (within about a second) before the kill.
 * `undefined` when that leaves less than the daemon's own shutdown grace: no deadline is set, and
 * the flush runs until it completes or the runtime kills it, as before.
 */
export const shutdownFinalDeadlineMs = (stopGraceMs: number): number | undefined => {
  const margin = Math.min(60_000, Math.max(5_000, Math.floor(stopGraceMs / 10)));
  const deadline = stopGraceMs - margin;
  return deadline < DAEMON_SHUTDOWN_GRACE_MS ? undefined : deadline;
};

/**
 * The non-secret boot env for a capture source, in emission order. `platform` is a control-plane
 * hint and is deliberately not delivered: the daemon's behaviour does not depend on where it runs.
 * `stopGraceMs` is how long the runtime waits after `SIGTERM` before it kills the executor: the
 * daemon's shutdown final flush is bounded inside it (`SEALANT_SHUTDOWN_FINAL_DEADLINE_MS`), so a
 * flush that cannot finish exits 75 — the disk kept and recovered — rather than being killed.
 * An older daemon ignores it.
 */
export const captureSourceEnv = (
  source: CaptureWorkspaceSource,
  options: { readonly stopGraceMs?: number } = {},
): ReadonlyArray<readonly [string, string]> => [
  ["SEALANT_WORKSPACE_SOURCE", "capture"],
  [CAPTURE_ENDPOINT_ENV, source.endpoint],
  ...(source.worktreeId === undefined
    ? []
    : [[CAPTURE_WORKTREE_ID_ENV, source.worktreeId] as const]),
  ...(source.harnessHome === undefined
    ? []
    : [[CAPTURE_HARNESS_HOME_ENV, source.harnessHome] as const]),
  // Transport (sealantd 0.17+; an older daemon ignores these and dials whatever it is given).
  // Only an explicit `true` is delivered: absence is the strict default on the daemon's side.
  ...(source.transport?.plaintext === true ? [[CAPTURE_ALLOW_PLAINTEXT_ENV, "true"] as const] : []),
  ...(source.transport?.channelCaPem === undefined
    ? []
    : [[CAPTURE_CA_PEM_ENV, source.transport.channelCaPem] as const]),
  ...(source.transport?.objectCaPem === undefined
    ? []
    : [[CAPTURE_OBJECT_CA_PEM_ENV, source.transport.objectCaPem] as const]),
  ...shutdownFinalDeadlineEnv(options.stopGraceMs),
];

const shutdownFinalDeadlineEnv = (
  stopGraceMs: number | undefined,
): ReadonlyArray<readonly [string, string]> => {
  const deadline = stopGraceMs === undefined ? undefined : shutdownFinalDeadlineMs(stopGraceMs);
  return deadline === undefined ? [] : [[SHUTDOWN_FINAL_DEADLINE_ENV, String(deadline)]];
};
