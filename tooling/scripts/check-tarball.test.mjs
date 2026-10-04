import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { manifestTargets, tarballProblems } from "./check-tarball.mjs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

/** A tarball built from `files` (path → text) in a fresh directory; `extra` adds raw tar steps. */
const tarball = (t, files, extra = []) => {
  const directory = mkdtempSync(path.join(tmpdir(), "tarball-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), text);
  }
  const roots = [...new Set(Object.keys(files).map((file) => file.split("/")[0]))];
  execFileSync("tar", ["-cf", "out.tar", ...roots], { cwd: directory });
  for (const step of extra) step(directory);
  execFileSync("gzip", ["out.tar"], { cwd: directory });
  return path.join(directory, "out.tar.gz");
};

const manifest = (version, extra = {}) =>
  JSON.stringify({
    name: "@sealant-test/x",
    version,
    gitHead: "abc",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./gen/*": "./dist/gen/*.js",
    },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    ...extra,
  });

const built = {
  "package/package.json": manifest("0.39.0-next.9"),
  "package/dist/index.js": "export {};",
  "package/dist/index.d.ts": "export {};",
  "package/dist/gen/a.js": "export {};",
};

const entriesOf = (file) =>
  execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).split("\n").filter(Boolean);

test("every file a manifest points at is collected", () => {
  assert.deepEqual(
    manifestTargets(JSON.parse(manifest("1.0.0", { bin: { x: "./bin/x.js" } }))).sort(),
    ["./bin/x.js", "./dist/gen/*.js", "./dist/index.d.ts", "./dist/index.js"],
  );
});

test("a built package passes; one packed without its build does not", (t) => {
  const good = tarball(t, built);
  assert.deepEqual(tarballProblems(entriesOf(good), JSON.parse(built["package/package.json"])), []);
  const unbuilt = tarball(t, {
    "package/package.json": manifest("0.39.0-next.9"),
    "package/README.md": "x",
  });
  assert.deepEqual(tarballProblems(entriesOf(unbuilt), JSON.parse(manifest("0.39.0-next.9"))), [
    "./dist/index.d.ts is not in the tarball",
    "./dist/index.js is not in the tarball",
    "./dist/gen/*.js is not in the tarball",
  ]);
});

/** The publish job's check, as written in .github/workflows/next.yml, run with bash. */
const publishCheck = () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/next.yml"), "utf8");
  const begin = workflow.indexOf("# --- tarball check ---");
  const end = workflow.indexOf("# --- end tarball check ---");
  assert.ok(begin > 0 && end > begin, "next.yml carries the tarball check block");
  const lines = workflow.slice(begin, end).split("\n");
  const indent = /^ */.exec(lines[0] ?? "")?.[0].length ?? 0;
  return lines.map((line) => line.slice(indent)).join("\n");
};
// As in the workflow: run in the tarballs' directory, naming the tarball relatively.
const runPublishCheck = (file, version) =>
  spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail\n${publishCheck()}\ncheck_tarball "$@"`,
      "check",
      path.basename(file),
      "@sealant-test/x",
      version,
      "abc",
    ],
    { encoding: "utf8", cwd: path.dirname(file) },
  );

test("the publish check accepts the real thing", (t) => {
  const result = runPublishCheck(tarball(t, built), "0.39.0-next.9");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("a second package.json outside package/ is refused before npm can read it", (t) => {
  // npm extracts with strip: 1, so zzz/package.json would land on top and publish 0.39.0.
  const crafted = tarball(t, { ...built, "zzz/package.json": manifest("0.39.0") });
  assert.deepEqual(tarballProblems(entriesOf(crafted), JSON.parse(built["package/package.json"])), [
    "entries outside package/: zzz/, zzz/package.json",
  ]);
  const result = runPublishCheck(crafted, "0.39.0-next.9");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /outside package\//);
});

test("a second package/package.json entry is refused", (t) => {
  const doubled = tarball(t, built, [
    (directory) => {
      mkdirSync(path.join(directory, "again/package"), { recursive: true });
      writeFileSync(path.join(directory, "again/package/package.json"), manifest("0.39.0"));
      execFileSync("tar", ["-rf", "out.tar", "-C", "again", "package/package.json"], {
        cwd: directory,
      });
    },
  ]);
  assert.deepEqual(tarballProblems(entriesOf(doubled), JSON.parse(built["package/package.json"])), [
    "2 package/package.json entries, not 1",
  ]);
  const result = runPublishCheck(doubled, "0.39.0-next.9");
  assert.notEqual(result.status, 0);
});

test("a manifest that is not this run's next version is refused, as npm itself reads it", (t) => {
  const stable = tarball(t, { ...built, "package/package.json": manifest("0.39.0") });
  const result = runPublishCheck(stable, "0.39.0-next.9");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm would publish version 0\.39\.0, 0\.39\.0 is not a next version/);
});
