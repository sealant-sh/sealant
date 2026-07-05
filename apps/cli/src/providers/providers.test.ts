import { describe, expect, it } from "vitest";

import { parseClearList } from "../commands/profiles.js";
import { candidateExecutablePaths } from "../tools.js";
import { CLAUDE_TOKEN_PREFIX, validateClaudeToken } from "./claude.js";
import { codexAuthPath, validateCodexAuthJson } from "./codex.js";
import { parseOAuthScopes } from "./github.js";

describe("validateClaudeToken", () => {
  it("accepts and trims a well-formed token", () => {
    const result = validateClaudeToken(`  ${CLAUDE_TOKEN_PREFIX}abc123  `);
    expect(result).toEqual({ ok: true, token: `${CLAUDE_TOKEN_PREFIX}abc123` });
  });

  it("rejects an empty token", () => {
    expect(validateClaudeToken("   ").ok).toBe(false);
  });

  it("rejects the wrong prefix (e.g. an API key)", () => {
    const result = validateClaudeToken("sk-ant-api03-xyz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(CLAUDE_TOKEN_PREFIX);
    }
  });

  it("rejects a bare prefix", () => {
    expect(validateClaudeToken(CLAUDE_TOKEN_PREFIX).ok).toBe(false);
  });
});

describe("codexAuthPath", () => {
  it("prefers CODEX_HOME", () => {
    expect(codexAuthPath({ CODEX_HOME: "/codex" }, "/home/dev")).toBe("/codex/auth.json");
  });

  it("falls back to ~/.codex/auth.json", () => {
    expect(codexAuthPath({}, "/home/dev")).toBe("/home/dev/.codex/auth.json");
  });
});

describe("validateCodexAuthJson", () => {
  it("accepts a chatgpt session with a refresh token", () => {
    const contents = JSON.stringify({ tokens: { refresh_token: "rt_1", id_token: "x" } });
    expect(validateCodexAuthJson(contents)).toEqual({ ok: true, authMode: "chatgpt" });
  });

  it("accepts an API-key session", () => {
    expect(validateCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: "sk-x" }))).toEqual({
      ok: true,
      authMode: "api-key",
    });
  });

  it("names what is missing", () => {
    const result = validateCodexAuthJson(JSON.stringify({ tokens: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("refresh_token");
      expect(result.reason).toContain("OPENAI_API_KEY");
    }
  });

  it("rejects invalid JSON", () => {
    expect(validateCodexAuthJson("{oops").ok).toBe(false);
  });
});

describe("parseOAuthScopes", () => {
  it("splits and trims the header", () => {
    expect(parseOAuthScopes("repo, workflow , gist")).toEqual(["repo", "workflow", "gist"]);
  });

  it("handles a missing or empty header", () => {
    expect(parseOAuthScopes(null)).toEqual([]);
    expect(parseOAuthScopes("")).toEqual([]);
  });
});

describe("parseClearList", () => {
  it("parses and deduplicates providers", () => {
    expect(parseClearList("claude, codex,claude")).toEqual({
      ok: true,
      providers: ["claude", "codex"],
    });
  });

  it("rejects unknown providers", () => {
    const result = parseClearList("claude,openai");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("openai");
    }
  });

  it("rejects an empty list", () => {
    expect(parseClearList(" , ").ok).toBe(false);
  });
});

describe("candidateExecutablePaths", () => {
  it("joins each PATH entry with the command", () => {
    expect(candidateExecutablePaths("gh", "/usr/bin:/opt/bin", ":")).toEqual([
      "/usr/bin/gh",
      "/opt/bin/gh",
    ]);
  });

  it("skips empty PATH entries", () => {
    expect(candidateExecutablePaths("gh", "::/usr/bin:", ":")).toEqual(["/usr/bin/gh"]);
  });

  it("handles an unset PATH", () => {
    expect(candidateExecutablePaths("gh", undefined, ":")).toEqual([]);
  });
});
