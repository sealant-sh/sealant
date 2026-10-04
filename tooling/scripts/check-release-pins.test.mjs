import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_DEPENDENTS,
  SEALANTD_IMAGE_FILES,
  prereleaseImages,
  prereleaseLocks,
  prereleaseRanges,
  releasePinProblems,
} from "./check-release-pins.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFile(path.join(root, file), "utf8");

test("every file the guard reads names sealantd, so a moved pin cannot slip past it", async () => {
  for (const file of SEALANTD_IMAGE_FILES) {
    assert.match(await read(file), /ghcr\.io\/sealant-sh\/sealantd:/, file);
  }
  for (const file of RUNTIME_DEPENDENTS) {
    const manifest = JSON.parse(await read(file));
    assert.ok(manifest.dependencies["@sealant/runtime-client"], file);
  }
});

test("main's pins are judged as they are; a prerelease pin is named wherever it sits", async () => {
  const imageFiles = Object.fromEntries(
    await Promise.all(SEALANTD_IMAGE_FILES.map(async (file) => [file, await read(file)])),
  );
  const manifests = Object.fromEntries(
    await Promise.all(RUNTIME_DEPENDENTS.map(async (file) => [file, JSON.parse(await read(file))])),
  );
  const lockfile = await read("pnpm-lock.yaml");
  // Whatever main pins today, the guard reads all of it without throwing.
  assert.ok(Array.isArray(releasePinProblems({ imageFiles, manifests, lockfile })));

  const problems = releasePinProblems({
    imageFiles: {
      "packages/workspaces/src/buildkit/buildkit-builder.ts":
        'process.env["SEALANT_SEALANTD_IMAGE"] ?? "ghcr.io/sealant-sh/sealantd:0.20.0-next.7";',
      "apps/cf-bridge/Dockerfile": "COPY --from=ghcr.io/sealant-sh/sealantd:0.19.0 /a /a",
    },
    manifests: {
      "packages/workspaces/package.json": {
        dependencies: {
          "@sealant/runtime-client": "0.20.0-next.7",
          "@sealant/runtime-protocol": "0.20.0-next.7",
          effect: "4.0.0-beta.85",
        },
      },
      "packages/telemetry/package.json": { dependencies: { "@sealant/runtime-client": "^0.4.0" } },
    },
    lockfile: [
      "  '@sealant/runtime-client@0.20.0-next.7':",
      "  '@sealant/runtime-client@0.20.0-next.7':",
      "  '@sealant/runtime-protocol@0.19.0':",
      "  effect@4.0.0-beta.85:",
    ].join("\n"),
  });
  assert.deepEqual(problems, [
    "packages/workspaces/src/buildkit/buildkit-builder.ts pins ghcr.io/sealant-sh/sealantd:0.20.0-next.7.",
    "packages/workspaces/package.json depends on @sealant/runtime-client@0.20.0-next.7.",
    "packages/workspaces/package.json depends on @sealant/runtime-protocol@0.20.0-next.7.",
    "pnpm-lock.yaml resolves @sealant/runtime-client@0.20.0-next.7.",
  ]);
});

test("releases, latest and digests are not prereleases", () => {
  assert.deepEqual(
    prereleaseImages(
      "ghcr.io/sealant-sh/sealantd:0.19.0 ghcr.io/sealant-sh/sealantd:latest " +
        `ghcr.io/sealant-sh/sealantd:0.19.1@sha256:${"a".repeat(64)}`,
    ),
    [],
  );
  assert.deepEqual(
    prereleaseRanges({ dependencies: { "@sealant/runtime-client": "^0.19.0" } }),
    [],
  );
  assert.deepEqual(prereleaseLocks("  '@sealant/runtime-client@0.19.0':\n"), []);
});
