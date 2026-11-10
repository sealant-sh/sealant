import {
  BoatControlMaterial,
  boatConnectMaterial,
  targetDerivationOptionsFromEnv,
} from "@sealant/workspaces";
import { Effect, Option } from "effect";

import { env } from "../runtime-env.js";

/**
 * How this process reaches a run's daemon: the env-derived options (TLS, bearer, MicroVM endpoint
 * tokens), plus Boat when the deployment gave the API its Boat key. Each Boat connection asks Boat
 * for fresh hosted access.
 */
export const requestTargetOptions = Effect.gen(function* () {
  const boat = yield* Effect.serviceOption(BoatControlMaterial);
  return {
    ...targetDerivationOptionsFromEnv(env),
    ...(Option.isNone(boat) ? {} : { boatConnectMaterial: boatConnectMaterial(boat.value) }),
  };
});
