import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { zipStored } from "./zip.js";

const hasUnzip = (() => {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("zipStored", () => {
  const entries = [
    { name: "Dockerfile", content: Buffer.from("FROM scratch\n") },
    { name: "agent.mjs", content: Buffer.from("console.log('ü');\n") },
  ];

  it("gives equal bytes for equal contents", () => {
    expect(zipStored(entries).equals(zipStored(entries))).toBe(true);
  });

  it.skipIf(!hasUnzip)("is read back byte for byte by unzip", () => {
    const directory = mkdtempSync(join(tmpdir(), "sealant-zip-"));
    const archive = join(directory, "context.zip");
    writeFileSync(archive, zipStored(entries));
    execFileSync("unzip", ["-q", "-o", archive, "-d", directory]);
    for (const entry of entries) {
      expect(readFileSync(join(directory, entry.name)).equals(entry.content)).toBe(true);
    }
  });

  it("refuses a name that could leave the context", () => {
    for (const name of ["", "/etc/passwd", "../x", "a/../../x", "a\\b"]) {
      expect(() => zipStored([{ name, content: Buffer.alloc(0) }])).toThrow(/Refusing/);
    }
  });
});
