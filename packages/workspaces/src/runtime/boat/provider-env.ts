import { HttpBoatApi } from "./api.js";
import { BoatApiError } from "./config.js";
import { loadBoatCredential } from "./credential.js";

/** The Boat provider settings every process that reaches Boat reads (`boatProviderEnvSchema`). */
export interface BoatProviderEnvLike {
  readonly SEALANT_BOAT_API_KEY?: string | undefined;
  readonly SEALANT_BOAT_API_KEY_FILE?: string | undefined;
  readonly SEALANT_BOAT_DEPLOYMENT_ID?: string | undefined;
}

/**
 * This process's Boat client and deployment, or `undefined` when no Boat key is configured. The key
 * is read once (from the value or the root-owned file) into the client and nowhere else; a refused
 * key or a missing deployment throws an error that names neither the key nor its file.
 */
export const boatProviderFromEnv = (
  env: BoatProviderEnvLike,
): { readonly deploymentId: string; readonly api: HttpBoatApi } | undefined => {
  if (env.SEALANT_BOAT_API_KEY === undefined && env.SEALANT_BOAT_API_KEY_FILE === undefined)
    return undefined;
  if (env.SEALANT_BOAT_DEPLOYMENT_ID === undefined)
    throw new BoatApiError("config", null, "deployment_id_missing");
  const credential = loadBoatCredential({
    value: env.SEALANT_BOAT_API_KEY,
    file: env.SEALANT_BOAT_API_KEY_FILE,
  });
  if (!credential.ok) throw credential.error;
  const api = HttpBoatApi.create({ credential: credential.value });
  if (!api.ok) throw api.error;
  return { deploymentId: env.SEALANT_BOAT_DEPLOYMENT_ID, api: api.value };
};
