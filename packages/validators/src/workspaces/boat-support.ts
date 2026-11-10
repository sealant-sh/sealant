import type { WorkspaceBlueprint } from "./workspace-blueprint.js";

/** The Boat runtime family, served where the deployment configures Boat. */
export const BOAT_RUNTIME_ID = "boat";

/** Shared preflight result for create and the Boat adapter. */
export type BoatSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly reason: "runtime-os-unsupported" | "runtime-requirement-unsupported";
      readonly detail: string;
      readonly message: string;
    };

const refuse = (
  reason: Extract<BoatSupport, { supported: false }>["reason"],
  detail: string,
  message: string,
): BoatSupport => ({ supported: false, reason, detail, message });

/** Pure native requirements. Scope authorization and runtime availability belong to their owners. */
export const boatSupport = (spec: WorkspaceBlueprint): BoatSupport => {
  const family = spec.target.os.family;
  if (family === "arch" || family === "fedora")
    return refuse(
      "runtime-os-unsupported",
      "native-unsupported-os",
      `Boat supports Ubuntu and Nix; ${family} is unsupported.`,
    );
  if (family === "custom" || spec.target.os.baseImage !== undefined)
    return refuse(
      "runtime-requirement-unsupported",
      "native-custom-base-unsupported",
      "Boat cannot boot a custom OCI base image.",
    );
  if (spec.runtime.ociRuntime === "runsc")
    return refuse(
      "runtime-requirement-unsupported",
      "native-oci-runtime-unsupported",
      "Boat cannot supply the runsc OCI runtime.",
    );
  if (
    spec.sources.workspace.kind === "mount" ||
    spec.sources.workspace.kind === "standby" ||
    spec.sources.mounts.length > 0
  )
    return refuse(
      "runtime-requirement-unsupported",
      "native-host-bind-unsupported",
      "Boat cannot bind directories from the control-plane host.",
    );
  if (spec.runtime.envFrom.length > 0 || spec.runtime.kubernetes.serviceAccountName !== undefined)
    return refuse(
      "runtime-requirement-unsupported",
      "native-cluster-env-unsupported",
      "Boat cannot resolve Kubernetes environment references.",
    );
  return { supported: true };
};
