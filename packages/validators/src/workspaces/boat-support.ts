import { runtimeRefusal, runtimeSupport, type RuntimeRequirement } from "./runtime-support.js";
import type { WorkspaceBlueprint } from "./workspace-blueprint.js";

/** The Boat runtime family, served where the deployment configures Boat. */
export const BOAT_RUNTIME_ID = "boat";

/** Shared preflight result for the Boat image builder and the Boat adapter. */
export type BoatSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly reason: "runtime-os-unsupported" | "runtime-requirement-unsupported";
      readonly detail: string;
      readonly message: string;
    };

/**
 * Boat's items in the runtime table do not depend on the install, save for resources, which no
 * Boat check reads; this install stands in for any.
 */
const BOAT_SUPPORT = runtimeSupport(BOAT_RUNTIME_ID, {
  kubernetesDocker: false,
  microvmDocker: false,
  microvmAgentPort: 8080,
  containerArchitecture: "x86_64",
  resourceHost: "none",
});

/** What shapes a Boat image; the source a workspace starts from is the launch's business. */
const IMAGE_REQUIREMENTS: readonly RuntimeRequirement[] = [
  "os",
  "customImage",
  "gvisor",
  "hostDirectories",
  "clusterEnv",
];

const toBoatSupport = (refusal: ReturnType<typeof runtimeRefusal>): BoatSupport => {
  if (refusal === undefined) return { supported: true };
  // Boat refuses with these two codes only: it serves Docker, and its cluster env item is a
  // runtime requirement.
  const reason =
    refusal.code === "runtime-os-unsupported"
      ? "runtime-os-unsupported"
      : "runtime-requirement-unsupported";
  return { supported: false, reason, detail: refusal.detail, message: refusal.message };
};

/**
 * Pure native image requirements, from the runtime table. Scope authorization and runtime
 * availability belong to their owners.
 */
export const boatSupport = (spec: WorkspaceBlueprint): BoatSupport =>
  toBoatSupport(runtimeRefusal(BOAT_SUPPORT, spec, IMAGE_REQUIREMENTS));

/** Everything a Boat launch requires of its blueprint, its source and dotfiles included. */
export const boatLaunchSupport = (spec: WorkspaceBlueprint): BoatSupport =>
  toBoatSupport(runtimeRefusal(BOAT_SUPPORT, spec));
