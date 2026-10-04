import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  aliasDependencies,
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
      "apps/cf-bridge/Dockerfile": `COPY --from=ghcr.io/sealant-sh/sealantd:0.19.0@sha256:${"a".repeat(64)} /a /a`,
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
    "packages/workspaces/src/buildkit/buildkit-builder.ts pins ghcr.io/sealant-sh/sealantd:0.20.0-next.7, not a release by digest.",
    "packages/workspaces/package.json depends on @sealant/runtime-client@0.20.0-next.7.",
    "packages/workspaces/package.json depends on @sealant/runtime-protocol@0.20.0-next.7.",
    "pnpm-lock.yaml resolves @sealant/runtime-client@0.20.0-next.7.",
  ]);
});

test("a sealantd pinned by digest alone, or by latest, is not a release", () => {
  const digest = `sha256:${"c".repeat(64)}`;
  assert.deepEqual(
    prereleaseImages(
      `FROM ghcr.io/sealant-sh/sealantd@${digest} AS d\nCOPY --from=ghcr.io/sealant-sh/sealantd:latest /a /a`,
    ),
    [`ghcr.io/sealant-sh/sealantd@${digest}`, "ghcr.io/sealant-sh/sealantd:latest"],
  );
});

test("a next build's -next image and -next packages are prereleases too", () => {
  assert.deepEqual(
    prereleaseImages("COPY --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.7 /a /a"),
    ["ghcr.io/sealant-sh/sealantd-next:0.20.0-next.7"],
  );
  assert.deepEqual(
    prereleaseRanges({
      dependencies: { "@sealant/runtime-client": "npm:@sealant/runtime-client-next@0.20.0-next.7" },
    }),
    ["@sealant/runtime-client@npm:@sealant/runtime-client-next@0.20.0-next.7"],
  );
  assert.deepEqual(prereleaseLocks("  '@sealant/runtime-client-next@0.20.0-next.7':\n"), [
    "@sealant/runtime-client-next@0.20.0-next.7",
  ]);
});

test("a release counts only with its digest: a tag alone can be moved", () => {
  assert.deepEqual(
    prereleaseImages(`ghcr.io/sealant-sh/sealantd:0.19.1@sha256:${"a".repeat(64)}`),
    [],
  );
  assert.deepEqual(prereleaseImages("ghcr.io/sealant-sh/sealantd:0.19.0"), [
    "ghcr.io/sealant-sh/sealantd:0.19.0",
  ]);
  assert.deepEqual(
    prereleaseRanges({ dependencies: { "@sealant/runtime-client": "^0.19.0" } }),
    [],
  );
  assert.deepEqual(prereleaseLocks("  '@sealant/runtime-client@0.19.0':\n"), []);
});

test("the published packages may depend on no npm alias", async () => {
  for (const file of ["packages/sdk/package.json", "packages/api-contracts/package.json"]) {
    assert.deepEqual(aliasDependencies(JSON.parse(await read(file))), [], file);
  }
  assert.deepEqual(
    aliasDependencies({
      dependencies: { "@sealant/api-contracts": "npm:@sealant/api-contracts-next@0.39.0-next.9" },
    }),
    ["@sealant/api-contracts@npm:@sealant/api-contracts-next@0.39.0-next.9"],
  );
  assert.match(
    releasePinProblems({
      imageFiles: {},
      manifests: {},
      lockfile: "",
      published: { "packages/sdk/package.json": { dependencies: { x: "npm:y@1.0.0" } } },
    })[0],
    /packages\/sdk\/package\.json depends on x@npm:y@1\.0\.0/,
  );
});
