import {
  WorkspaceBadRequestError,
  WorkspaceConflictError,
  WorkspaceInternalServerError,
  WorkspaceNotFoundError,
  WorkspaceServiceUnavailableError,
} from "@sealant/api-contracts";
import { BoatAccountRepo } from "@sealant/db";
import { BOAT_RUNTIME_ID } from "@sealant/validators";
import {
  HttpBoatApi,
  unregisteredRuntimeRefusal,
  type BoatResult,
  type BoatSecret,
} from "@sealant/workspaces";
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

/** The reads the API asks of Boat with a key it was given, before it stores the key. */
export type BoatKeyClient = Pick<HttpBoatApi, "verifyCredential" | "get" | "getSnapshot">;

/** How the API opens a Boat key it was given into a client: Boat's real API; a test's fake. */
export const BoatKeyClients = Context.Reference<
  (credential: BoatSecret) => BoatResult<BoatKeyClient>
>("@sealant/api/BoatKeyClients", {
  defaultValue: () => (credential) => HttpBoatApi.create({ credential }),
});

/**
 * Whether this install can launch Boat, as the API answers it today: it was given the Boat key.
 * The create's refusal and the runtime report (`GET /v1/workspaces/runtimes`) both read this one
 * answer, so a better one replaces it here.
 */
export const boatLaunchable = Effect.gen(function* () {
  return yield* BoatConfigured;
});

/** Boat on a deployment that did not configure it is refused like any unregistered runtime. */
export const requireBoatConfigured = Effect.gen(function* () {
  if (yield* boatLaunchable) return;
  return yield* new WorkspaceServiceUnavailableError(unregisteredRuntimeRefusal(BOAT_RUNTIME_ID));
});

/**
 * The Boat account a workspace's spec names (`runtime.boatAccountId`) is one it may run in: the
 * workspace runs on Boat, and the account is stored on this install and not being removed. A spec
 * that names none runs in the install's default account and needs nothing here.
 */
export const requireBoatAccount = (
  spec: { readonly runtime: { readonly boatAccountId?: string | undefined } },
  runtimeFamily: string,
) =>
  Effect.gen(function* () {
    const accountId = spec.runtime.boatAccountId;
    if (accountId === undefined) return;
    if (runtimeFamily !== BOAT_RUNTIME_ID)
      return yield* new WorkspaceBadRequestError({
        message: `spec.runtime.boatAccountId names a Boat account, and this workspace runs on ${runtimeFamily}, not Boat. Name a Boat account only for a workspace on the Boat runtime.`,
      });
    const account = yield* (yield* BoatAccountRepo)
      .get(accountId)
      .pipe(
        Effect.mapError(
          () =>
            new WorkspaceInternalServerError({ message: "Failed to read the named Boat account." }),
        ),
      );
    if (account === undefined || account.removedAt !== null)
      return yield* new WorkspaceNotFoundError({
        message: `No Boat account ${accountId} is stored on this install (spec.runtime.boatAccountId).`,
      });
    if (account.removalRequestedAt !== null)
      return yield* new WorkspaceConflictError({
        message: `Boat account ${accountId} is being removed: no new workspace runs in it.`,
      });
  });
