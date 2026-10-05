import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { prereleaseImages } from "./check-release-pins.mjs";
import { IMAGE_FILES, repositoryFor, rewriteImages, runtimeSpecs } from "./pin-sealantd.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = `sha256:${"d".repeat(64)}`;

test("every sealantd reference is rewritten to tag@sha256, whatever form it had", () => {
  const text = [
    'process.env["SEALANT_SEALANTD_IMAGE"] ?? "ghcr.io/sealant-sh/sealantd:0.19.0";',
    "COPY --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.7 /a /a",
    `COPY --from=ghcr.io/sealant-sh/sealantd@sha256:${"e".repeat(64)} /b /b`,
  ].join("\n");
  const pinned = rewriteImages(text, `ghcr.io/sealant-sh/sealantd:0.20.0@${digest}`);
  assert.equal(pinned.match(new RegExp(`sealantd:0\\.20\\.0@${digest}`, "g"))?.length, 3);
  assert.deepEqual(prereleaseImages(pinned), []);
});

test("a release is the plain names; a next build the -next names, as exact aliases", () => {
  assert.equal(repositoryFor("0.20.0"), "sealant-sh/sealantd");
  assert.equal(repositoryFor("0.20.0-next.139"), "sealant-sh/sealantd-next");
  assert.deepEqual(runtimeSpecs("0.20.0"), {
    "@sealant/runtime-client": "0.20.0",
    "@sealant/runtime-protocol": "0.20.0",
  });
  assert.deepEqual(runtimeSpecs("0.20.0-next.139"), {
    "@sealant/runtime-client": "npm:@sealant/runtime-client-next@0.20.0-next.139",
    "@sealant/runtime-protocol": "npm:@sealant/runtime-protocol-next@0.20.0-next.139",
  });
});

// Main may pin a sealantd prerelease (ADR 0015 in sealant-sh/mend); a stable release refusing one
// is check-release-pins.mjs's job. Here every reference is a release or a next build, by digest.
const PINNED =
  /^ghcr\.io\/sealant-sh\/(?:sealantd:\d+\.\d+\.\d+|sealantd-next:\d+\.\d+\.\d+-next\.\d+)@sha256:[0-9a-f]{64}$/;

test("the checked-in pins are tag@sha256, which only this script writes", async () => {
  for (const file of IMAGE_FILES) {
    const text = await readFile(path.join(root, file), "utf8");
    const references = [
      ...text.matchAll(/ghcr\.io\/sealant-sh\/sealantd(?:-next)?(?:[:@][0-9A-Za-z.:@-]+)?/g),
    ].map((match) => match[0]);
    assert.notEqual(references.length, 0, file);
    for (const reference of references) assert.match(reference, PINNED, file);
  }
});
