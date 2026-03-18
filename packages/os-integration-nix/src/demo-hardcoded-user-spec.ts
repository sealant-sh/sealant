import { normalizeUserWorkspaceSpec } from "@zweit/workspace-composition";

import { mapBlueprintToNixExecutorSpec } from "./map-blueprint-to-nix-executor-spec.js";
import { NixOsExecutor } from "./nix-executor.js";

// This is the minimal end-to-end demo path for the new contracts: start from a
// user-facing JSON-like spec, normalize it, map it into the current Nix spec,
// and optionally compile it through the existing Nix backend.
const hardcodedUserSpec = {
  source: "https://github.com/ypanagidis/nixcfg.git",
  harness: "opencode",
  packages: ["nodejs", "pnpm", "ripgrep"],
  env: {
    ZWEIT_PROFILE: "demo",
  },
  os: "nix",
};

const blueprint = normalizeUserWorkspaceSpec(hardcodedUserSpec);
const nixSpec = mapBlueprintToNixExecutorSpec(blueprint);
const executor = new NixOsExecutor();
const support = executor.supports({ blueprint });

console.log(JSON.stringify({ hardcodedUserSpec, blueprint, support, nixSpec }, null, 2));

if (!support.supported) {
  process.exitCode = 1;
  throw new Error(support.message);
}

if (process.argv.includes("--build")) {
  const result = await executor.compile({ blueprint });
  console.log(JSON.stringify(result, null, 2));
}
