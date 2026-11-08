import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { loadBoatCredential } from "./credential.js";

describe("Boat credential boundary", () => {
  it("rejects ambiguous inputs and keeps every public credential representation redacted", () => {
    const key = "synthetic-test-key-only";
    expect(loadBoatCredential({ value: key, file: "/run/secrets/key" }).ok).toBe(false);
    const parsed = loadBoatCredential({ value: key });
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain(key);
    expect(String(parsed.ok ? parsed.value : parsed.error)).not.toContain(key);
    for (const file of ["relative", "/tmp/../key", "/tmp//key", "/key"])
      expect(loadBoatCredential({ file }).ok).toBe(false);
  });
  it("opens actual root-owned files and refuses permissions, replacements and special files without blocking", () => {
    const program = `
      import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, symlinkSync, linkSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { loadBoatCredential } from './src/runtime/boat/credential.ts';
      const root = mkdtempSync(join(tmpdir(), 'boat-credential-test-'));
      const parent = join(root, 'private');
      const key = 'synthetic-test-key-only';
      const path = join(parent, 'key');
      const results = [];
      const check = () => loadBoatCredential({file:path}).ok;
      try {
        mkdirSync(parent, {mode:0o700});
        writeFileSync(path, key+'\\n', {mode:0o400});
        results.push(check());
        chmodSync(path, 0o600); results.push(check());
        chmodSync(path, 0o400); chmodSync(parent,0o755); results.push(check());
        chmodSync(parent,0o700); linkSync(path,join(parent,'hardlink')); results.push(check());
        rmSync(join(parent,'hardlink')); rmSync(path); symlinkSync('/etc/hostname',path); results.push(check());
        rmSync(path); execFileSync('mkfifo',[path]); results.push(check());
        rmSync(path); writeFileSync(path,'x'.repeat(4098),{mode:0o400}); results.push(check());
        rmSync(path); writeFileSync(path,'bad key with spaces',{mode:0o400}); results.push(check());
        rmSync(path); writeFileSync(path,key,{mode:0o400});
        symlinkSync(parent,join(root,'alias')); results.push(loadBoatCredential({file:join(root,'alias','key')}).ok);
        results.push(!JSON.stringify(loadBoatCredential({file:path})).includes(key));
        process.stdout.write(JSON.stringify(results));
      } finally { rmSync(root,{recursive:true,force:true}); }
    `;
    const result = execFileSync(
      "unshare",
      ["-Urn", process.execPath, "--import", "tsx", "--input-type=module", "-e", program],
      { timeout: 15_000, encoding: "utf8" },
    );
    expect(JSON.parse(result)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });
});
