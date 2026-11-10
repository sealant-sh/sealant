import { WorkspaceServiceUnavailableError } from "@sealant/api-contracts";
import { BOAT_RUNTIME_ID } from "@sealant/validators";
import { unregisteredRuntimeRefusal } from "@sealant/workspaces";
import { Context, Effect } from "effect";

import { env } from "../runtime-env.js";

/**
 * Whether this deployment serves Boat, as far as the API can tell: it was given the Boat key (the
 * env schema then holds the deployment and the credential cipher beside it), the way it holds AWS
 * credentials for MicroVM. Every principal that may create workspaces is served alike.
 */
export const BoatConfigured = Context.Reference<boolean>("@sealant/api/BoatConfigured", {
  defaultValue: () =>
    env.SEALANT_BOAT_API_KEY !== undefined || env.SEALANT_BOAT_API_KEY_FILE !== undefined,
});

/** Boat on a deployment that did not configure it is refused like any unregistered runtime. */
export const requireBoatConfigured = Effect.gen(function* () {
  if (yield* BoatConfigured) return;
  return yield* new WorkspaceServiceUnavailableError(unregisteredRuntimeRefusal(BOAT_RUNTIME_ID));
});
