import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { manifestTargets, tarballProblems } from "./check-tarball.mjs";

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

test("a second manifest outside package/ is refused", (t) => {
  const crafted = tarball(t, { ...built, "zzz/package.json": manifest("0.39.0") });
  assert.deepEqual(tarballProblems(entriesOf(crafted), JSON.parse(built["package/package.json"])), [
    "entries outside package/: zzz/, zzz/package.json",
  ]);
});

test("a second package/package.json entry is refused, however its path is spelled", (t) => {
  for (const spelling of [
    "package/package.json",
    "package/./package.json",
    "package//package.json",
  ]) {
    const doubled = tarball(t, built, [
      (directory) => {
        mkdirSync(path.join(directory, "again/package"), { recursive: true });
        writeFileSync(path.join(directory, "again/package/package.json"), manifest("0.39.0"));
        execFileSync(
          "tar",
          [
            "-rf",
            "out.tar",
            "-C",
            "again",
            "--transform",
            `s,^package/package.json$,${spelling},`,
            "package/package.json",
          ],
          { cwd: directory },
        );
      },
    ]);
    assert.deepEqual(
      tarballProblems(entriesOf(doubled), JSON.parse(built["package/package.json"])),
      ["2 package/package.json entries, not 1"],
      spelling,
    );
  }
});
