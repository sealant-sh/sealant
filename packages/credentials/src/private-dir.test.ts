import * as fs from "node:fs";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { provisionClaudeConfigDir, provisionClaudeKeyDir } from "./claude-session.js";
import { provisionCodexHome } from "./codex-session.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "private-dir-test-"));
  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
    throw new Error("ENOSPC: no space left on device");
  });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("a provisioning whose write fails", () => {
  it.each([
    ["a Claude key dir", () => provisionClaudeKeyDir({ apiKey: "sk-ant-api03-FAKE", baseDir })],
    ["a Claude session dir", () => provisionClaudeConfigDir({ credentialsJson: "{}", baseDir })],
    ["a Codex home", () => provisionCodexHome({ authJson: "{}", baseDir })],
  ])("leaves no %s behind", (_name, provision) => {
    expect(provision).toThrow("ENOSPC");
    expect(readdirSync(baseDir)).toEqual([]);
  });
});
