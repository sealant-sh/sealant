import { normalizeUserWorkspaceSpec } from "@sealant/workspace-composition";

import {
  getNixExecutorSupport,
  mapBlueprintToNixExecutorSpec,
} from "./map-blueprint-to-nix-executor-spec.js";

// This is the minimal end-to-end demo path for the new contracts: start from a
// user-facing JSON-like spec, normalize it, map it into the current Nix spec,
// and optionally compile it through the existing Nix backend.
const hardcodedUserSpec = {
  source: "https://github.com/ypanagidis/nixcfg.git",
  harness: "opencode",
  packages: ["nodejs", "pnpm", "ripgrep"],
  env: {
    SEALANT_PROFILE: "demo",
  },
  os: "nix",
};

const blueprint = normalizeUserWorkspaceSpec(hardcodedUserSpec);
const nixSpec = mapBlueprintToNixExecutorSpec(blueprint);
const support = getNixExecutorSupport(blueprint);

console.log(JSON.stringify({ hardcodedUserSpec, blueprint, support, nixSpec }, null, 2));

if (!support.supported) {
  process.exitCode = 1;
  throw new Error(support.message);
}

if (process.argv.includes("--build")) {
  throw new Error(
    "Local Nix execution is disabled. Run builds through the worker+nix-builder container flow.",
  );
}
