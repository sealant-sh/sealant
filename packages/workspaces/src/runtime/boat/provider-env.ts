import { BoatAccountRepo, BoatAccountRepoLive, SealantDB, type DB } from "@sealant/db";
import { Effect } from "effect";

import { httpBoatClientFactory, type BoatClientFactory } from "./accounts.js";
import type { BoatApi } from "./api.js";
import { loadBoatCredential } from "./credential.js";

/** The Boat provider settings every process that reaches Boat reads (`boatProviderEnvSchema`). */
export interface BoatProviderEnvLike {
  readonly SEALANT_BOAT_API_KEY?: string | undefined;
  readonly SEALANT_BOAT_API_KEY_FILE?: string | undefined;
  readonly SEALANT_BOAT_DEPLOYMENT_ID?: string | undefined;
  readonly SEALANT_BOAT_ORGANIZATION?: string | undefined;
}

/** The install's own Boat account as a process holds it: its client, and what the env names. */
export interface BoatEnvAccount {
  readonly api: BoatApi;
  /** The operator's `SEALANT_BOAT_DEPLOYMENT_ID`; absent: the install's stored name is used. */
  readonly deploymentId: string | undefined;
  /** The organization the key bills (`SEALANT_BOAT_ORGANIZATION`), named on every request. */
  readonly organization: string | undefined;
}

/**
 * This process's default Boat account (the env key): its client, or `undefined` when no Boat key is
 * configured. The key is read once (from the value or the root-owned file) into the client and
 * nowhere else; a refused key throws an error that names neither the key nor its file. The client
 * names `SEALANT_BOAT_ORGANIZATION` on every request when it is set. `clientFor` opens the key;
 * default: Boat's real API.
 */
export const boatProviderFromEnv = (
  env: BoatProviderEnvLike,
  clientFor: BoatClientFactory = httpBoatClientFactory,
): BoatEnvAccount | undefined => {
  if (env.SEALANT_BOAT_API_KEY === undefined && env.SEALANT_BOAT_API_KEY_FILE === undefined)
    return undefined;
  const credential = loadBoatCredential({
    value: env.SEALANT_BOAT_API_KEY,
    file: env.SEALANT_BOAT_API_KEY_FILE,
  });
  if (!credential.ok) throw credential.error;
  const organization = env.SEALANT_BOAT_ORGANIZATION;
  const api = clientFor(
    credential.value,
    organization === undefined ? undefined : { organization },
  );
  if (!api.ok) throw api.error;
  return { api: api.value, deploymentId: env.SEALANT_BOAT_DEPLOYMENT_ID, organization };
};

/**
 * The names of the install's own Boat account: the operator's settings where they are set, else
 * the ones the install keeps in its database (`boat_install`), made once the first time any
 * process asks. A setting given here is adopted by the database when it holds none yet, so an
 * install that drops a setting later keeps the name its VMs and images already carry. The builder
 * owner is asked for only by a worker that builds images (`withBuilder`).
 */
export const boatInstallNames = (
  input: {
    readonly deploymentId?: string | undefined;
    readonly builderOwner?: string | undefined;
    readonly withBuilder: boolean;
  },
  db: DB,
): Promise<{ readonly deploymentId: string; readonly builderOwner: string | undefined }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* BoatAccountRepo;
      const deploymentId = yield* repo.installDeployment(input.deploymentId);
      const builderOwner = input.withBuilder
        ? yield* repo.installBuilderOwner(input.builderOwner)
        : undefined;
      return {
        deploymentId: input.deploymentId ?? deploymentId,
        builderOwner: input.builderOwner ?? builderOwner,
      };
    }).pipe(Effect.provide(BoatAccountRepoLive), Effect.provideService(SealantDB, db)),
  );
