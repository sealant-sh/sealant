/**
 * Whether an image, on a given runtime, can run Mend's per-person layout (Mend ADR 0016, decision 1),
 * as the API reports it: the image's verdict from its build's probe (`metadata.imageProbe`, read
 * by `imagePersonLayoutSupport`, with the runtime's `no_new_privs`), and whether the runtime's
 * `/workspace` takes ACLs, as the operator declares it. Anything not known is `unknown`, never
 * `supported`.
 */
import type { RuntimeAdapterId, WorkspaceImageProbe } from "@sealant/validators";

import { imagePersonLayoutSupport, imageRunsProcessesAsUser } from "../buildkit/person-layout.js";

export type PersonLayoutStatus = "supported" | "unsupported" | "unknown";

export interface PersonLayoutCapability {
  readonly status: PersonLayoutStatus;
  /** Stable codes of what the image or the runtime lacks (`setuid-sudo`, `setpriv`, `acl`, …). */
  readonly missing: readonly string[];
  /** What could not be read (`probe` when the image has none, `sealantd`, `flock`, `acl`). */
  readonly unknown: readonly string[];
  /** The runtime the capability is for. */
  readonly runtime: RuntimeAdapterId;
  /** ACLs on that runtime's `/workspace`, as the operator declared them. */
  readonly acl: PersonLayoutStatus;
}

export interface PersonLayoutContext {
  readonly runtime: RuntimeAdapterId;
  readonly acl: "supported" | "unsupported" | undefined;
}

/** Runtimes whose workspaces run with `no_new_privs` (Kubernetes: `allowPrivilegeEscalation: false`). */
const NO_NEW_PRIVILEGES_RUNTIMES: ReadonlySet<RuntimeAdapterId> = new Set(["k8s", "k3s"]);

export const personLayoutCapability = (
  probe: WorkspaceImageProbe | undefined,
  context: PersonLayoutContext,
): PersonLayoutCapability => {
  const acl: PersonLayoutStatus = context.acl ?? "unknown";
  const image =
    probe === undefined
      ? { missing: [] as readonly string[], unknown: ["probe"] as readonly string[] }
      : imagePersonLayoutSupport(probe, {
          noNewPrivileges: NO_NEW_PRIVILEGES_RUNTIMES.has(context.runtime),
        });
  const missing = [...image.missing, ...(acl === "unsupported" ? ["acl"] : [])];
  const unknown = [...image.unknown, ...(acl === "unknown" ? ["acl"] : [])];
  return {
    status: missing.length > 0 ? "unsupported" : unknown.length > 0 ? "unknown" : "supported",
    missing,
    unknown,
    runtime: context.runtime,
    acl,
  };
};

/** Runtimes whose daemon Core never asks to start a process as a user (no per-person capability). */
const NO_PROCESS_USER_RUNTIMES: ReadonlySet<RuntimeAdapterId> = new Set(["cloudflare"]);

/**
 * Whether a workspace's processes can be started as a person's user (`user` on exec and sessions),
 * as its read reports it: from the sealantd its image's probe asked (`exec.user`), on a runtime
 * whose daemon Core reaches (Docker, MicroVM, Kubernetes; never Cloudflare's sandboxes). What is
 * not known (an image built before the probe, an unreadable answer) is `unknown`. The exec or
 * session itself asks the running daemon, whose answer decides.
 */
export const processUserCapability = (
  probe: WorkspaceImageProbe | undefined,
  runtime: RuntimeAdapterId,
): PersonLayoutStatus => {
  if (NO_PROCESS_USER_RUNTIMES.has(runtime)) return "unsupported";
  switch (imageRunsProcessesAsUser(probe)) {
    case "yes":
      return "supported";
    case "no":
      return "unsupported";
    case "unknown":
      return "unknown";
  }
};

/** Whether a runtime's daemon is ever asked to start a process as a user. */
export const runtimeRunsProcessesAsUser = (runtime: RuntimeAdapterId): boolean =>
  !NO_PROCESS_USER_RUNTIMES.has(runtime);
