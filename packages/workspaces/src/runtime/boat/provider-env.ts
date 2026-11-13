import { BoatAccountRepo, BoatAccountRepoLive, SealantDB, type DB } from "@sealant/db";
import { Effect } from "effect";

import type { BoatSecret } from "./config.js";
import { loadBoatCredential } from "./credential.js";

/** The Boat provider settings every process that reaches Boat reads (`boatProviderEnvSchema`). */
export interface BoatProviderEnvLike {
  readonly SEALANT_BOAT_API_KEY?: string | undefined;
  readonly SEALANT_BOAT_API_KEY_FILE?: string | undefined;
  readonly SEALANT_BOAT_DEPLOYMENT_ID?: string | undefined;
  readonly SEALANT_BOAT_ORGANIZATION?: string | undefined;
}

/** The install's own Boat key as a process holds it, and what the env names. */
export interface BoatEnvAccount {
  /** The key, opened once from the value or the root-owned file. */
  readonly credential: BoatSecret;
  /** The operator's `SEALANT_BOAT_DEPLOYMENT_ID`; absent: the install's stored name is used. */
  readonly deploymentId: string | undefined;
  /**
   * The wallet the operator names (`SEALANT_BOAT_ORGANIZATION`). Its requests name the wallet
   * `boat_install` holds (`installBoatApi`): this one, once applied (at once on a new install, and
   * once nothing of the install's runs, builds or full checks is in the wallet it named before).
   */
  readonly organization: string | undefined;
}

/**
 * This process's default Boat key (the env key), or `undefined` when none is configured. The key
 * is read once (from the value or the root-owned file); a refused key throws an error that names
 * neither the key nor its file. Its client is `installBoatApi`, which names the install's wallet.
 */
export const boatProviderFromEnv = (env: BoatProviderEnvLike): BoatEnvAccount | undefined => {
  if (env.SEALANT_BOAT_API_KEY === undefined && env.SEALANT_BOAT_API_KEY_FILE === undefined)
    return undefined;
  const credential = loadBoatCredential({
    value: env.SEALANT_BOAT_API_KEY,
    file: env.SEALANT_BOAT_API_KEY_FILE,
  });
  if (!credential.ok) throw credential.error;
  return {
    credential: credential.value,
    deploymentId: env.SEALANT_BOAT_DEPLOYMENT_ID,
    organization: env.SEALANT_BOAT_ORGANIZATION,
  };
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
