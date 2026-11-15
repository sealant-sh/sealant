import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { runEvidence, scanFile } from "./evidence.mjs";
import { makeResult, writeResult } from "./result.mjs";

// Built at run time so no credential-shaped literal sits in the repository.
const FAKE_GITHUB = `ghp_${"a1".repeat(18)}`;
const SECRET = "s3cr3t-value-from-env-9f2";

/** A PNG holding only text chunks: what the scan reads of an image. */
function png(chunks) {
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (const [type, data] of chunks) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    parts.push(length, Buffer.from(type, "latin1"), data, Buffer.alloc(4));
  }
  return Buffer.concat(parts);
}

function scratch(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "verify-evidence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("the scan finds a secret value or a credential shape, and passes the repo's local defaults", (t) => {
  const directory = scratch(t);
  const file = (name, content) => {
    writeFileSync(path.join(directory, name), content);
    return path.join(directory, name);
  };
  assert.deepEqual(scanFile(file("clean.log", "migrated 42 tables\n"), [SECRET]), []);
  assert.equal(scanFile(file("value.log", `token=${SECRET}\n`), [SECRET]).length, 1);
  assert.deepEqual(scanFile(file("shape.log", `auth ${FAKE_GITHUB}\n`), []), ["github-token"]);
  assert.deepEqual(
    scanFile(file("local.log", "postgresql://postgres:postgres@127.0.0.1:5432/sealant_test\n"), []),
    [],
    "the CI and verify db password is published",
  );
  assert.deepEqual(
    scanFile(file("remote.log", "postgresql://app:Zq8kLm2pRt@db.internal:5432/app\n"), []),
    ["url-password"],
  );
});

test("an image is searched in its text chunks, compressed ones included", (t) => {
  const directory = scratch(t);
  const keyword = Buffer.from("Comment\0", "latin1");
  const plain = path.join(directory, "plain.png");
  writeFileSync(plain, png([["tEXt", Buffer.concat([keyword, Buffer.from(SECRET)])]]));
  assert.equal(scanFile(plain, [SECRET]).length, 1);
  const compressed = path.join(directory, "z.png");
  writeFileSync(
    compressed,
    png([["zTXt", Buffer.concat([keyword, Buffer.from([0]), deflateSync(`key ${FAKE_GITHUB}`)])]]),
  );
  assert.deepEqual(scanFile(compressed, []), ["github-token"]);
  const pixels = path.join(directory, "pixels.png");
  writeFileSync(pixels, png([["IDAT", Buffer.from(SECRET)]]));
  assert.deepEqual(scanFile(pixels, [SECRET]), [], "pixels are not text: the verdict says so");
});

test("evidence gathers this commit's clean results, withholds a log with a secret, writes the verdict", (t) => {
  const root = scratch(t);
  const sha = "f".repeat(40);
  const head = { sha, branch: "b", dirty: false, base: "origin/main", mergeBase: null };
  mkdirSync(path.join(root, ".verify/logs"), { recursive: true });
  writeFileSync(path.join(root, ".verify/logs/check-tests.log"), "412 passed\n");
  writeFileSync(path.join(root, ".verify/logs/db-x.log"), `connected with ${FAKE_GITHUB}\n`);
  const result = (verb, overrides, log) =>
    writeResult(
      root,
      makeResult({
        verb,
        head: { ...head, ...overrides },
        startedAt: new Date(),
        steps: [{ id: verb, title: verb, status: "passed", ...(log === undefined ? {} : { log }) }],
      }),
    );
  result("check", {}, ".verify/logs/check-tests.log");
  result("db", {}, ".verify/logs/db-x.log");
  result("plan", { sha: "e".repeat(40) }, undefined);
  result("formal", { dirty: true }, undefined);
  mkdirSync(path.join(root, ".verify/shots", sha.slice(0, 12)), { recursive: true });
  writeFileSync(path.join(root, ".verify/shots", sha.slice(0, 12), "home.png"), png([]));

  const { steps, evidence } = runEvidence({ root, head, receipt: "### Verification\n" });
  const out = path.join(root, ".verify/evidence", sha.slice(0, 12));
  assert.equal(
    steps.find((step) => step.id === "gather").detail.startsWith("2 result(s), 1 screenshot(s)"),
    true,
  );
  assert.equal(steps.find((step) => step.id === "scan").status, "evidence_withheld");
  assert.ok(existsSync(path.join(out, "logs/check-check-tests.log")), "a clean log is kept");
  assert.ok(!existsSync(path.join(out, "logs/db-db-x.log")), "the log with a token is deleted");
  const verdict = readFileSync(path.join(out, "verdict.md"), "utf8");
  assert.match(verdict, /Withheld 1 file\(s\): `.*db-db-x\.log` \(github-token\)/);
  assert.doesNotMatch(
    verdict + JSON.stringify(steps),
    new RegExp(FAKE_GITHUB),
    "no value is printed",
  );
  assert.ok(evidence.some(({ kind }) => kind === "screenshot"));
});

test("a dirty tree has no evidence: it belongs to a commit", (t) => {
  const root = scratch(t);
  const head = {
    sha: "a".repeat(40),
    branch: "b",
    dirty: true,
    base: "origin/main",
    mergeBase: null,
  };
  assert.equal(runEvidence({ root, head, receipt: "" }).steps[0].status, "skipped");
});
