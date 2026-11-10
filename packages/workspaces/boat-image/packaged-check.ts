import { fileURLToPath } from "node:url";

import { parseWorkspaceBlueprint } from "@sealant/validators";

import { loadPackagedRuntime, type NativeAssetDirectory } from "../src/images/boat/assets.js";
import { createNativeRecipe } from "../src/images/boat/recipe.js";
import fixture from "./fixtures/mend-screens.json" with { type: "json" };

// Bundled beside `boat-assets/` in the worker image: that directory is the staged layout.
const directory: NativeAssetDirectory = {
  root: fileURLToPath(new URL("../boat-assets/", import.meta.url)),
  layout: "staged",
};
const runtime = await loadPackagedRuntime(directory);
if (!runtime.ok) throw runtime.error;
for (const family of ["ubuntu", "nix"] as const) {
  const recipe = await createNativeRecipe(
    parseWorkspaceBlueprint(fixture[family].blueprint),
    runtime.value,
    { assetsDirectory: directory },
  );
  if (!recipe.ok) throw recipe.error;
  process.stdout.write(
    JSON.stringify({ family, hash: recipe.value.hash, assetsHash: recipe.value.assetsHash }) + "\n",
  );
}
