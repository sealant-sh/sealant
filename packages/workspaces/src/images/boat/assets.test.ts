import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseWorkspaceBlueprint } from "@sealant/validators";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import fixture from "../../../boat-image/fixtures/mend-screens.json" with { type: "json" };
import { loadPackagedRuntime, readNativeAssets } from "./assets.js";
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

describe("native packaged assets", () => {
  it("refuses a manifest whose packaged files are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "boat-assets-test-"));
    roots.push(root);
    const manifest = JSON.parse(
      await readFile(new URL("../../../boat-image/asset-lock.json", import.meta.url), "utf8"),
    );
    await writeFile(join(root, "asset-lock.json"), JSON.stringify(manifest));
    expect(await readNativeAssets(root)).toMatchObject({ ok: false });
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
      const shipped = await loadPackagedRuntime(assets);
      if (!shipped.ok) throw shipped.error;
      for (const [index, family] of (["ubuntu", "nix"] as const).entries()) {
        const source = await createNativeRecipe(
          parseWorkspaceBlueprint(fixture[family].blueprint),
          shipped.value,
        );
        if (!source.ok) throw source.error;
        expect(lines[index]?.hash).toBe(source.value.hash);
        expect(lines[index]?.assetsHash).toBe(source.value.assetsHash);
      }
      const path = join(assets, "workspace-launch.py");
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
