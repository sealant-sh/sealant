import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseWorkspaceBlueprint } from "@sealant/validators";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import lock from "../../../boat-image/asset-lock.json" with { type: "json" };
import fixture from "../../../boat-image/fixtures/mend-screens.json" with { type: "json" };
import { BOAT_AGENT_FILES } from "../../runtime/boat/agent-contract.js";
import { loadPackagedRuntime, nativeAssetDirectory, readNativeAssets } from "./assets.js";
import { createNativeRecipe } from "./recipe.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    process.stdout.write(
      JSON.stringify({ ownedScratch: root, entries: await readdir(root) }) + "\n",
    );
    await rm(root, { recursive: true });
  }
});
const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("native packaged assets", () => {
  it("locks every agent file the Boat image copies in, the Docker installer and the unit, by exact bytes", async () => {
    const sources = lock.files.map((file) => file.source);
    for (const source of BOAT_AGENT_FILES) expect(sources).toContain(source);
    expect(sources).toContain("microvm-image/download-docker.sh");
    expect(sources).toContain("boat-image/sealant-agent.service");
    for (const file of lock.files)
      expect(
        createHash("sha256")
          .update(await readFile(join(packageRoot, file.source)))
          .digest("hex"),
        file.source,
      ).toBe(file.sha256);
    const assets = await readNativeAssets();
    if (!assets.ok) throw assets.error;
    expect([...assets.value.keys()].toSorted()).toEqual(
      lock.files.map((file) => file.name).toSorted(),
    );
    expect(nativeAssetDirectory().layout).toBe("source");
  });

  it("refuses a manifest whose packaged files are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "boat-assets-test-"));
    roots.push(root);
    await writeFile(join(root, "asset-lock.json"), JSON.stringify(lock));
    expect(await readNativeAssets({ root, layout: "staged" })).toMatchObject({ ok: false });
    // A runtime bundle is only ever read from a staged directory.
    expect(await loadPackagedRuntime(nativeAssetDirectory())).toMatchObject({
      ok: false,
      error: { code: "native-runtime-bundle-unavailable" },
    });
  });

  it.skipIf(!process.env.SEALANT_BOAT_RUNTIME_BUNDLE)(
    "runs the standalone worker asset checker and refuses a changed or missing packaged file",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "boat-packaged-worker-"));
      roots.push(root);
      const stage = fileURLToPath(new URL("../../../boat-image/stage-assets.mjs", import.meta.url));
      const assets = join(root, "boat-assets");
      execFileSync(
        process.execPath,
        [stage, assets, process.env.SEALANT_BOAT_RUNTIME_BUNDLE ?? ""],
        {
          cwd: root,
        },
      );
      const check = join(root, "dist/boat-assets-check.mjs");
      const lines = execFileSync(process.execPath, [check], { cwd: root, encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line: string) =>
          z
            .object({
              family: z.enum(["ubuntu", "nix"]),
              hash: z.string().regex(/^[a-f0-9]{64}$/),
              assetsHash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .parse(JSON.parse(line)),
        );
      expect(lines.map((line) => line.family)).toEqual(["ubuntu", "nix"]);
      const staged = { root: assets, layout: "staged" } as const;
      const shipped = await loadPackagedRuntime(staged);
      if (!shipped.ok) throw shipped.error;
      for (const [index, family] of (["ubuntu", "nix"] as const).entries()) {
        const source = await createNativeRecipe(
          parseWorkspaceBlueprint(fixture[family].blueprint),
          shipped.value,
          { assetsDirectory: staged },
        );
        if (!source.ok) throw source.error;
        expect(lines[index]?.hash).toBe(source.value.hash);
        expect(lines[index]?.assetsHash).toBe(source.value.assetsHash);
      }
      const path = join(assets, "boat-host.mjs");
      const original = await readFile(path);
      await writeFile(path, "modified");
      expect(() => execFileSync(process.execPath, [check], { cwd: root, stdio: "pipe" })).toThrow();
      await writeFile(path, original);
      expect(() =>
        execFileSync(process.execPath, [check], { cwd: root, stdio: "pipe" }),
      ).not.toThrow();
      await readdir(assets);
      await rm(path);
      expect(() => execFileSync(process.execPath, [check], { cwd: root, stdio: "pipe" })).toThrow();
    },
  );
});
