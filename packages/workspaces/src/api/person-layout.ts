/**
 * Whether an image, on this deployment's runtime, can run Mend's per-person layout (Mend ADR 0016,
 * decision 1): its sealantd runs processes and dotfiles as a user and restores owners, the image
 * has `sudo`, `useradd` and `setfacl` and no user or group in the reserved range, it is not a nix
 * image, and the runtime's `/workspace` takes ACLs. Derived from the image build's probe (recorded
 * on the build) and the operator's declaration of ACL support; anything not known is `unknown`,
 * never `supported`.
 */
import type { OsBuilderCompileMetadata, RuntimeAdapterId } from "@sealant/validators";

export type PersonLayoutProbe = NonNullable<OsBuilderCompileMetadata["personLayoutProbe"]>;

export type PersonLayoutSupport = "supported" | "unsupported" | "unknown";

export interface PersonLayoutCapability {
  readonly status: PersonLayoutSupport;
  /** What the image or the runtime lacks, in words; empty when nothing is known to be missing. */
  readonly missing: readonly string[];
  /** The runtime the capability is for (the deployment's default adapter). */
  readonly runtime: RuntimeAdapterId;
  /** ACLs on that runtime's `/workspace`, as the operator declared them. */
  readonly acl: PersonLayoutSupport;
}

export interface PersonLayoutContext {
  readonly runtime: RuntimeAdapterId;
  readonly acl: "supported" | "unsupported" | undefined;
}

export const personLayoutCapability = (
  probe: PersonLayoutProbe | undefined,
  context: PersonLayoutContext,
): PersonLayoutCapability => {
  const acl: PersonLayoutSupport = context.acl ?? "unknown";
  const base = { runtime: context.runtime, acl };
  if (probe === undefined) {
    return {
      ...base,
      status: acl === "unsupported" ? "unsupported" : "unknown",
      missing: acl === "unsupported" ? ["ACLs on /workspace"] : [],
    };
  }
  const missing = [
    ...(probe.sealantd.execUser ? [] : ["sealantd exec.user"]),
    ...(probe.sealantd.dotfilesUser ? [] : ["sealantd dotfiles.user"]),
    ...(probe.sealantd.restoreOwnerMap ? [] : ["sealantd restore.owner_map"]),
    ...(probe.tools.sudo ? [] : ["sudo"]),
    ...(probe.tools.useradd ? [] : ["useradd"]),
    ...(probe.tools.setfacl ? [] : ["setfacl"]),
    ...(probe.reservedIdsFree ? [] : ["a user or group in 40000–49999"]),
    ...(probe.nix ? ["a nix image takes one person"] : []),
    ...(acl === "unsupported" ? ["ACLs on /workspace"] : []),
  ];
  return {
    ...base,
    missing,
    status: missing.length > 0 ? "unsupported" : acl === "supported" ? "supported" : "unknown",
  };
};
