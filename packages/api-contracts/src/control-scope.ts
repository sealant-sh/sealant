/**
 * An executor's control scope (workspace isolation architecture §6.1): the one subdirectory of
 * the deployment's control root (Mend's `mend-control` volume, `WORKSPACE_CONTROL_SOCKET_HOST_DIR`)
 * that the executor mounts at `/run/sealant`. sealantd binds `control.sock` there; the caller
 * binds the executor's two channels to it there before the executor dials them:
 *
 *  - `capture.sock`: captures and presigned object requests. On `host-vm`, sealantd always dials
 *    it (vsock 1025, relayed to the socket); on `docker`, when the spec asks for it
 *    (`runtime.executorSockets.capture`). A recovery boot dials only this one.
 *  - `session.sock`: the session channel. On `host-vm`, relayed from vsock 1027 on normal boots
 *    only; on `docker`, reachable by the workspace's non-root processes when the spec asks for it
 *    (`runtime.executorSockets.session`).
 *
 * A create may name the scope (`controlScope`); without one it is the executor's container name.
 * Either way the executor reports it (`runtime.controlScope`).
 *
 * Deliberately dependency-free, like `network-policy.ts`: data plus pure functions, shared by the
 * SDK (client-side refusal with the server's wording), the API and the runtimes.
 */

/** One path segment: lowercase letters, digits, `_`, `.` and `-`, starting with a letter or digit. */
export const CONTROL_SCOPE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

/**
 * What no caller's scope may start with: every directory sealant makes in the control root (each
 * executor's `sealant-<run>` or `sealant-vm-<run>`, each egress proxy's `<name>-proxy`, which holds
 * its admin socket) starts with it. So a scope a caller names can never be another executor's or
 * a proxy's directory.
 */
export const RESERVED_CONTROL_SCOPE_PREFIX = "sealant";

/** Where an executor's control scope is mounted inside it. */
export const EXECUTOR_CONTROL_MOUNT = "/run/sealant";
/** The caller's capture relay in an executor's control scope. */
export const EXECUTOR_CAPTURE_SOCKET = "capture.sock";
/** The caller's session channel in an executor's control scope. */
export const EXECUTOR_SESSION_SOCKET = "session.sock";

/** Why a control scope is refused: constant words, never the value, so a refusal can repeat them. */
export const CONTROL_SCOPE_PROBLEMS = {
  shape:
    "must be one path segment of at most 128 lowercase letters, digits, '_', '.' or '-', starting with a letter or digit",
  reserved: `may not start with '${RESERVED_CONTROL_SCOPE_PREFIX}': sealant's own directories in the control root do`,
} as const;

/** Why `scope` cannot be a control scope a create names, or undefined when it can. */
export const controlScopeProblem = (scope: string): string | undefined => {
  if (!CONTROL_SCOPE_PATTERN.test(scope)) return CONTROL_SCOPE_PROBLEMS.shape;
  if (scope.startsWith(RESERVED_CONTROL_SCOPE_PREFIX)) return CONTROL_SCOPE_PROBLEMS.reserved;
  return undefined;
};
