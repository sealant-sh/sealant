import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  aliasDependencies,
  isDryRunVersion,
  RUNTIME_DEPENDENTS,
  SEALANTD_IMAGE_FILES,
  prereleaseImages,
  prereleaseLocks,
  prereleaseRanges,
  releasePinProblems,
} from "./check-release-pins.mjs";
import {
  NEXT_IMAGE,
  PRERELEASE_PROBLEMS,
  prereleaseCheckout,
} from "./fixtures/sealantd-prerelease-checkout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFile(path.join(root, file), "utf8");

test("every file the guard reads names sealantd, so a moved pin cannot slip past it", async () => {
  for (const file of SEALANTD_IMAGE_FILES) {
    assert.match(await read(file), /ghcr\.io\/sealant-sh\/sealantd(?:-next)?:/, file);
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
    {
      text: "packages/workspaces/src/buildkit/buildkit-builder.ts pins ghcr.io/sealant-sh/sealantd:0.20.0-next.7, not a release by digest.",
      // A tag alone, not pinned by digest: a dry run fails on it too.
      prerelease: false,
    },
    {
      text: "packages/workspaces/package.json depends on @sealant/runtime-client@0.20.0-next.7.",
      prerelease: true,
    },
    {
      text: "packages/workspaces/package.json depends on @sealant/runtime-protocol@0.20.0-next.7.",
      prerelease: true,
    },
    { text: "pnpm-lock.yaml resolves @sealant/runtime-client@0.20.0-next.7.", prerelease: true },
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
    })[0].text,
    /packages\/sdk\/package\.json depends on x@npm:y@1\.0\.0/,
  );
});

test("only --dry-run takes a dry-run version, and it takes nothing else", () => {
  const script = fileURLToPath(new URL("./check-release-pins.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  for (const version of ["0.38.1-dryrun.38700000001.1", "1.0.0-dryrun.9.2"])
    assert.ok(isDryRunVersion(version), version);
  for (const version of [
    "0.38.1",
    "0.38.1-next.4",
    "0.38.1-dryrun.0.1",
    "0.38.1-dryrun.1",
    "v0.38.1-dryrun.1.1",
    "0.38.1-dryrun.1.1.x",
  ])
    assert.ok(!isDryRunVersion(version), version);
  // A dry-run-shaped tag without the flag is a prerelease, refused before any pin is read.
  const pushed = run("v0.38.1-dryrun.38700000001.1");
  assert.equal(pushed.status, 1);
  assert.match(pushed.stderr, /is a prerelease/);
  // The flag with a release's version, or with a next build's, is refused too.
  for (const tag of ["v0.38.1", "v0.39.0-next.4"]) {
    const refused = run("--dry-run", tag);
    assert.equal(refused.status, 1, tag);
    assert.match(refused.stderr, /--dry-run checks a dry-run version/, tag);
  }
  assert.equal(run("--dry-run").status, 2);
});

// --- a dry run reports a sealantd prerelease, and fails on everything else ---

/** The lines of `stream` that are workflow commands `prefix`, without it. */
const commandLines = (stream, prefix) =>
  stream
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));

/** check-release-pins.mjs as copied into `checkout`, run there with a run summary file. */
const runPins = (checkout, ...args) => {
  const summary = `${checkout}/step-summary.md`;
  const result = spawnSync(
    process.execPath,
    [`${checkout}/tooling/scripts/check-release-pins.mjs`, ...args],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin", GITHUB_STEP_SUMMARY: summary } },
  );
  return {
    status: result.status,
    errors: commandLines(result.stdout + result.stderr, "::error::"),
    warnings: commandLines(result.stdout + result.stderr, "::warning::"),
    summary: existsSync(summary) ? readFileSync(summary, "utf8") : undefined,
    output: result.stdout + result.stderr,
  };
};

const DRY_TAG = "v0.38.1-dryrun.38983261452.1";
const dryRefusal = `${DRY_TAG} cannot release with a sealantd prerelease. Release sealantd, pin it, then tag.`;

test("a dry run warns on each sealantd prerelease pin, lists them in the summary, and passes", (t) => {
  const result = runPins(prereleaseCheckout(t), "--dry-run", DRY_TAG);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [...PRERELEASE_PROBLEMS, dryRefusal]);
  assert.equal(
    result.summary,
    [
      "### Release pins (dry run)",
      "",
      "A release would refuse:",
      "",
      ...[...PRERELEASE_PROBLEMS, dryRefusal].map((problem) => `- ${problem}`),
      "",
      "A dry run reports these as warnings; a vX.Y.Z tag refuses them.",
      "",
    ].join("\n"),
  );
  assert.match(result.output, /every other pin check passed; a release would refuse the 10 /);
});

test("a vX.Y.Z tag with the same prerelease pins refuses, as it always has", (t) => {
  const result = runPins(prereleaseCheckout(t), "v0.38.1");
  assert.equal(result.status, 1);
  assert.deepEqual(result.errors, [
    ...PRERELEASE_PROBLEMS,
    "v0.38.1 cannot release with a sealantd prerelease. Release sealantd, pin it, then tag.",
  ]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary, undefined);
});

const RELEASED_IMAGE = `ghcr.io/sealant-sh/sealantd:0.20.0@sha256:${"a".repeat(64)}`;
const releasedRuntime = {
  dependencies: { "@sealant/runtime-client": "0.20.0", "@sealant/runtime-protocol": "0.20.0" },
};
/** Files that make the fixture checkout pin a sealantd release everywhere. */
const releasedFiles = {
  "packages/workspaces/src/buildkit/buildkit-builder.ts": `"${RELEASED_IMAGE}";\n`,
  "apps/cf-bridge/Dockerfile": `COPY --from=${RELEASED_IMAGE} /a /a\n`,
  "apps/ssh-gateway/package.json": releasedRuntime,
  "packages/telemetry/package.json": releasedRuntime,
  "packages/workspaces/package.json": releasedRuntime,
  "pnpm-lock.yaml": "  '@sealant/runtime-client@0.20.0':\n",
};

test("a dry run with every sealantd pin a release writes no summary and passes", (t) => {
  const result = runPins(prereleaseCheckout(t, releasedFiles), "--dry-run", DRY_TAG);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual([result.errors, result.warnings, result.summary], [[], [], undefined]);
  assert.match(result.output, /every sealantd pin is a release/);
});

test("a dry run still fails on every problem that is not a sealantd prerelease", (t) => {
  const builder = "packages/workspaces/src/buildkit/buildkit-builder.ts";
  const digest = `sha256:${"c".repeat(64)}`;
  // Each family the script refuses, put into a checkout that otherwise pins a prerelease.
  for (const [what, files, problem] of [
    [
      "a tag without its digest",
      { [builder]: '"ghcr.io/sealant-sh/sealantd-next:0.20.0-next.157";' },
      `${builder} pins ghcr.io/sealant-sh/sealantd-next:0.20.0-next.157, not a release by digest.`,
    ],
    [
      "a digest without its tag",
      { [builder]: `"ghcr.io/sealant-sh/sealantd@${digest}";` },
      `${builder} pins ghcr.io/sealant-sh/sealantd@${digest}, not a release by digest.`,
    ],
    [
      "latest",
      { "apps/cf-bridge/Dockerfile": "COPY --from=ghcr.io/sealant-sh/sealantd:latest /a /a" },
      "apps/cf-bridge/Dockerfile pins ghcr.io/sealant-sh/sealantd:latest, not a release by digest.",
    ],
    [
      "a prerelease under the stable name, a shape pin-sealantd.mjs never writes",
      { [builder]: `"ghcr.io/sealant-sh/sealantd:0.20.0-next.157@${digest}";` },
      `${builder} pins ghcr.io/sealant-sh/sealantd:0.20.0-next.157@${digest}, not a release by digest.`,
    ],
    [
      "a release under the -next name",
      { [builder]: `"ghcr.io/sealant-sh/sealantd-next:0.20.0@${digest}";` },
      `${builder} pins ghcr.io/sealant-sh/sealantd-next:0.20.0@${digest}, not a release by digest.`,
    ],
    [
      "a digest cut short",
      { [builder]: '"ghcr.io/sealant-sh/sealantd-next:0.20.0-next.157@sha256:abc";' },
      `${builder} pins ghcr.io/sealant-sh/sealantd-next:0.20.0-next.157@sha256:abc, not a release by digest.`,
    ],
    [
      "a published package depending on an npm alias",
      {
        "packages/sdk/package.json": {
          dependencies: {
            "@sealant/api-contracts": "npm:@sealant/api-contracts-next@0.39.0-next.9",
          },
        },
      },
      "packages/sdk/package.json depends on @sealant/api-contracts@npm:@sealant/api-contracts-next@0.39.0-next.9.",
    ],
  ]) {
    const result = runPins(prereleaseCheckout(t, files), "--dry-run", DRY_TAG);
    assert.equal(result.status, 1, what);
    assert.deepEqual(
      result.errors,
      [
        problem,
        `${DRY_TAG} fails: a dry run reports only a sealantd prerelease, and these are not one.`,
      ],
      what,
    );
    // The prerelease pins beside it are still reported, as warnings and in the summary, and the
    // summary says this dry run failed, naming the problem, rather than that it went on.
    assert.ok(result.warnings.includes(dryRefusal), what);
    assert.ok(!result.warnings.includes(problem), what);
    const [refused, failed] = result.summary.split("This dry run also failed on:\n");
    assert.match(refused, /^A release would refuse:$/m, what);
    assert.ok(refused.includes(`- ${dryRefusal}`), what);
    assert.ok(!refused.includes(`- ${problem}`), what);
    assert.equal(failed, `\n- ${problem}\n\nA dry run fails on these as a release does.\n`, what);
    assert.doesNotMatch(result.summary, /went on/, what);
  }
  // The prerelease image the fixture pins is pin-sealantd.mjs's shape, the one a dry run reports.
  assert.deepEqual(prereleaseImages(`"${NEXT_IMAGE}"`), [NEXT_IMAGE]);
  // A tag of the wrong shape fails before any pin is read: a usage error, and a dry run's flag
  // with a release's or a next build's version (tested above).
  const checkout = prereleaseCheckout(t);
  for (const args of [
    ["--dry-run"],
    ["--dry-run", "0.38.1-dryrun.1.1"],
    ["--dry-run", DRY_TAG, "x"],
  ])
    assert.equal(runPins(checkout, ...args).status, 2, args.join(" "));
});

test("a reference is judged whole, to its delimiter, never by a prefix that looks pinned", (t) => {
  // Whitespace, a quote, a backtick or the end of the text ends a reference, as in a Dockerfile,
  // YAML or TypeScript; the pinned shapes main writes are read exactly.
  for (const [text, reference] of [
    [`"${NEXT_IMAGE}";`, NEXT_IMAGE],
    [`'${NEXT_IMAGE}'`, NEXT_IMAGE],
    [`\`${NEXT_IMAGE}\``, NEXT_IMAGE],
    [`COPY --from=${NEXT_IMAGE} /a /a`, NEXT_IMAGE],
    [`image: ${NEXT_IMAGE}\nnext: 1`, NEXT_IMAGE],
    [`FROM ${NEXT_IMAGE}`, NEXT_IMAGE],
  ])
    assert.deepEqual(prereleaseImages(text), [reference], text);
  assert.deepEqual(
    prereleaseImages(`"${RELEASED_IMAGE}";\nCOPY --from=${RELEASED_IMAGE} /a /a`),
    [],
  );

  const builder = "packages/workspaces/src/buildkit/buildkit-builder.ts";
  const dockerfile = "apps/cf-bridge/Dockerfile";
  for (const suffix of ["_wrong", "/wrong", ".", "-", ":", "b", "@sha256:x"]) {
    // A next build's reference with something after its digest: not pin-sealantd.mjs's shape, so a
    // dry run fails on it, in a Dockerfile or in TypeScript, naming the whole reference.
    for (const [file, content] of [
      [dockerfile, `COPY --from=${NEXT_IMAGE}${suffix} /a /a\n`],
      [builder, `"${NEXT_IMAGE}${suffix}";\n`],
    ]) {
      const result = runPins(prereleaseCheckout(t, { [file]: content }), "--dry-run", DRY_TAG);
      const problem = `${file} pins ${NEXT_IMAGE}${suffix}, not a release by digest.`;
      assert.equal(result.status, 1, `${file} ${suffix}`);
      assert.ok(result.errors.includes(problem), `${file} ${suffix}: ${result.output}`);
      assert.ok(
        !result.warnings.some((line) => line.includes(`${NEXT_IMAGE}${suffix}`)),
        `${file} ${suffix}`,
      );
    }
    // A release's reference with the same suffix is no release: a tag refuses it, a dry run too.
    const released = prereleaseCheckout(t, {
      ...releasedFiles,
      [dockerfile]: `COPY --from=${RELEASED_IMAGE}${suffix} /a /a\n`,
    });
    const problem = `${dockerfile} pins ${RELEASED_IMAGE}${suffix}, not a release by digest.`;
    const tagged = runPins(released, "v0.38.1");
    assert.equal(tagged.status, 1, `release ${suffix}`);
    assert.deepEqual(
      tagged.errors,
      [
        problem,
        "v0.38.1 cannot release with a sealantd prerelease. Release sealantd, pin it, then tag.",
      ],
      `release ${suffix}`,
    );
    const dry = runPins(released, "--dry-run", DRY_TAG);
    assert.equal(dry.status, 1, `dry run of a release ${suffix}`);
    assert.equal(dry.errors[0], problem, `dry run of a release ${suffix}`);
  }
});
