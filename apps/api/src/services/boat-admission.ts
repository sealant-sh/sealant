import type { WorkspaceBlueprint } from "@sealant/validators";
import { Context, Effect } from "effect";

import { env } from "../runtime-env.js";
import { CurrentPrincipal } from "./service-principals.js";

/** Operator-only routing trusts Mend's service-asserted owner, not person authentication. */
export const BoatAdmissionOwners = Context.Reference<readonly string[]>(
  "@sealant/api/BoatAdmissionOwners",
  { defaultValue: () => env.SEALANT_BOAT_ADMISSION_OWNER_IDS },
);

export const boatOwnerAdmitted = (ownerId: string) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    return principal.kind === "service" && (yield* BoatAdmissionOwners).includes(ownerId);
  });

/** An explicit runtime choice is preserved. All other owners retain the deployment default. */
export const routeBoatOwner = (spec: WorkspaceBlueprint, admitted: boolean): WorkspaceBlueprint =>
  admitted && spec.target.runtime.family === "auto"
    ? { ...spec, target: { ...spec.target, runtime: { family: "boat", mode: "require" } } }
    : spec;
