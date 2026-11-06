import { parseWorkspaceBlueprint } from "@sealant/validators";

import { loadPackagedRuntime } from "../src/images/boat/assets.js";
import { createNativeRecipe } from "../src/images/boat/recipe.js";
import fixture from "./fixtures/mend-screens.json" with { type: "json" };

const runtime = await loadPackagedRuntime();
if (!runtime.ok) throw runtime.error;
for (const family of ["ubuntu", "nix"] as const) {
  const recipe = await createNativeRecipe(
    parseWorkspaceBlueprint(fixture[family].blueprint),
    runtime.value,
  );
  if (!recipe.ok) throw recipe.error;
  process.stdout.write(
    JSON.stringify({ family, hash: recipe.value.hash, assetsHash: recipe.value.assetsHash }) + "\n",
  );
}
