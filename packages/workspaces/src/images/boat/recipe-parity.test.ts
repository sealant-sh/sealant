import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createWorkspaceBuildSpec } from "../../buildkit/docker-parity.fixture.js";
import { createNativeRecipe } from "./recipe.js";
import { NATIVE_RUNTIME_PIN, sha256 } from "./runtime-bundle.js";

const bundle = {
  identity: { ...NATIVE_RUNTIME_PIN, platform: "linux/amd64" as const },
  files: () =>
    (["sealantd", "sealantctl"] as const).map((name) => ({
      path: `/usr/local/bin/${name}`,
      bytes: Buffer.from(name),
      sha256: sha256(name),
    })),
};

/** Files whose bytes are the shipped agent assets, or digests over them. */
const ASSET_DERIVED = new Set([
  "/var/lib/sealant/agent/manifest.json",
  "/etc/sealant/native-inputs.json",
]);
const isAsset = (path: string) =>
  path.startsWith("/opt/sealant/") ||
  path.startsWith("/usr/local/bin/") ||
  path === "/etc/systemd/system/sealant-agent.service";

/**
 * What the Boat recipe generates, for each family (Ubuntu, Nix), shell, Docker choice and harness: the install
 * script, the boot entries, the path and mode of every file, and the bytes of every file it writes
 * itself (the project install, the boot file, the drop-ins). The agent's shipped files are left
 * out: `asset-lock.json` pins them, and they would tie this baseline to every agent change.
 */
const recipeCases = async () => {
  const cases: Array<{ readonly name: string; readonly sha256: string }> = [];
  for (const family of ["ubuntu", "nix"] as const)
    for (const shell of ["bash", "zsh", "fish"] as const)
      for (const docker of [false, true])
        for (const harness of ["codex", "claude-code", "opencode", "pi"] as const) {
          const base = createWorkspaceBuildSpec({
            harness: { id: harness },
            target: {
              os: { family, mode: "require" },
              runtime: { family: "auto", mode: "prefer" },
            },
            customization: {
              defaultShell: shell,
              dotfilesManager: "auto",
              dotfilesTarget: "home",
              applyDotfiles: true,
              dotfilesBootstrap: true,
            },
          });
          const spec = docker
            ? { ...base, tooling: { ...base.tooling, services: { docker: { enabled: true } } } }
            : base;
          const recipe = await createNativeRecipe(spec, bundle);
          if (!recipe.ok) throw recipe.error;
          const generated = {
            installScript: recipe.value.installScript,
            bootEntries: recipe.value.bootEntries,
            files: recipe.value.files.map((file) => ({
              path: file.path,
              mode: file.mode,
              ...(isAsset(file.path) || ASSET_DERIVED.has(file.path)
                ? {}
                : { sha256: file.sha256 }),
            })),
          };
          cases.push({
            name: [family, shell, docker ? "docker" : "plain", harness].join("/"),
            sha256: createHash("sha256").update(JSON.stringify(generated)).digest("hex"),
          });
        }
  return cases;
};

describe("Boat Ubuntu and Nix recipes", () => {
  it("generate every byte they generated before", async () => {
    const baseline: unknown = JSON.parse(
      readFileSync(new URL("./recipe-parity.json", import.meta.url), "utf8"),
    );
    expect(await recipeCases()).toEqual(baseline);
  });
});
