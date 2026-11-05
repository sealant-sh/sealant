import type { WorkspaceBlueprint } from "@sealant/validators";
import { Context, Effect, Layer } from "effect";

import { createNativeRecipe } from "./recipe.js";
import { NativeBuildError, type VerifiedRuntimeBundle } from "./runtime-bundle.js";

/** Read-only native planning needs the exact verified bundle, never a Containerfile planner. */
export interface BoatImageInspectionService {
  readonly plan: (
    spec: WorkspaceBlueprint,
  ) => Effect.Effect<{ readonly planHash: string }, NativeBuildError>;
}

/** Final composition supplies the verified bundle before native inspection is available. */
export class BoatImageInspection extends Context.Service<
  BoatImageInspection,
  BoatImageInspectionService
>()("@sealant/workspaces/BoatImageInspection") {}

/** No provider, journal, catalog reservation or publication mutation occurs during inspection. */
export const boatImageInspectionLayer = (bundle: VerifiedRuntimeBundle) =>
  Layer.succeed(BoatImageInspection, {
    plan: (spec) =>
      Effect.tryPromise({
        try: () => createNativeRecipe(spec, bundle),
        catch: () => new NativeBuildError("native-recipe-io-failed"),
      }).pipe(
        Effect.flatMap((result) =>
          result.ok ? Effect.succeed({ planHash: result.value.hash }) : Effect.fail(result.error),
        ),
      ),
  });
