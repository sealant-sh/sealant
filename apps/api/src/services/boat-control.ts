import { BoatInteractiveControl, targetDerivationOptionsFromEnv } from "@sealant/workspaces";
import { Effect, Option } from "effect";

import { env } from "../runtime-env.js";

/** Provider credentials stay in the worker; every connection requests fresh current authority. */
export const requestTargetOptions = Effect.gen(function* () {
  const control = yield* Effect.serviceOption(BoatInteractiveControl);
  return {
    ...targetDerivationOptionsFromEnv(env),
    ...(Option.isNone(control) ? {} : { boatConnectMaterial: control.value.connectMaterial }),
  };
});
