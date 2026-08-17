import { describe, expect, it } from "vitest";

import {
  findWorkspaceEnvReservedRule,
  formatWorkspaceEnvIssue,
  parseWorkspaceEnv,
  WORKSPACE_ENV_MAX_ENTRIES,
  WORKSPACE_ENV_MAX_TOTAL_BYTES,
  WORKSPACE_ENV_MAX_VALUE_BYTES,
} from "./index.js";

const expectIssues = (input: Record<string, string>) => {
  const result = parseWorkspaceEnv(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues;
};

describe("parseWorkspaceEnv", () => {
  it("accepts ordinary configuration, including empty and multiline values", () => {
    const result = parseWorkspaceEnv({
      APP_MODE: "review",
      EMPTY: "",
      MULTILINE: "line one\nline two\n",
      _UNDERSCORE_START: "ok",
      lower_case: "ok",
      UNICODE_VALUE: "café ☕",
    });
    expect(result).toEqual({
      ok: true,
      env: {
        APP_MODE: "review",
        EMPTY: "",
        MULTILINE: "line one\nline two\n",
        UNICODE_VALUE: "café ☕",
        _UNDERSCORE_START: "ok",
        lower_case: "ok",
      },
    });
  });

  it("re-serializes the accepted map in name order for determinism", () => {
    const result = parseWorkspaceEnv({ ZULU: "1", ALPHA: "2", MIKE: "3" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.env)).toEqual(["ALPHA", "MIKE", "ZULU"]);
    }
  });

  it.each([
    ["1LEADING_DIGIT", "name-grammar"],
    ["WITH-DASH", "name-grammar"],
    ["WITH SPACE", "name-grammar"],
    ["", "name-grammar"],
    ["UNICODE_NÄME", "name-grammar"],
    [`L${"O".repeat(130)}NG`, "name-length"],
  ] as const)("rejects malformed name %j via %s without echoing a value", (name, rule) => {
    const issues = expectIssues({ [name]: "attacker-visible-value" });
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue?.rule).toBe(rule);
    // Malformed names surface as index + bounded display; the value never appears anywhere.
    expect(JSON.stringify(issues)).not.toContain("attacker-visible-value");
    expect(issue !== undefined && "index" in issue && issue.index).toBe(0);
  });

  it("bounds the escaped rendering of a malformed name", () => {
    const issues = expectIssues({ [`BAD NAME ${"X".repeat(200)}`]: "v" });
    const issue = issues[0];
    if (issue !== undefined && "nameDisplay" in issue) {
      expect(issue.nameDisplay.length).toBeLessThan(50);
    } else {
      expect.unreachable("expected a nameDisplay-bearing issue");
    }
  });

  it.each([
    ["SEALANT_WORKSPACE_ROOT", "platform-prefix"],
    ["sealant_anything", "platform-prefix"],
    ["HOME", "process-identity"],
    ["PATH", "process-identity"],
    ["TERM", "process-identity"],
    ["_", "process-identity"],
    ["DOCKER_HOST", "runtime-network"],
    ["http_proxy", "runtime-network"],
    ["NO_PROXY", "runtime-network"],
    ["CLAUDE_CODE_OAUTH_TOKEN", "account-lookup"],
    ["XDG_CONFIG_HOME", "account-lookup"],
    ["CODEX_HOME", "account-lookup"],
    ["LD_PRELOAD", "dynamic-loader"],
    ["DYLD_INSERT_LIBRARIES", "dynamic-loader"],
    ["GLIBC_TUNABLES", "dynamic-loader"],
    ["BASH_ENV", "shell-startup"],
    ["ENV", "shell-startup"],
    ["PROMPT_COMMAND", "shell-startup"],
    ["NODE_OPTIONS", "runtime-injection"],
    ["PYTHONPATH", "runtime-injection"],
    ["JAVA_TOOL_OPTIONS", "runtime-injection"],
    ["SSH_AUTH_SOCK", "git-ssh"],
    ["GIT_SSH_COMMAND", "git-ssh"],
    ["GIT_CONFIG_KEY_0", "git-ssh"],
    ["GIT_CONFIG_VALUE_0", "git-ssh"],
  ] as const)("reserves %s (%s)", (name, reservedRule) => {
    expect(findWorkspaceEnvReservedRule(name)).toBe(reservedRule);
    const issues = expectIssues({ [name]: "v" });
    expect(issues).toEqual([{ rule: "name-reserved", name, reservedRule }]);
  });

  // The exact mirror of sealantd's is_secret_key: a name the daemon would silently drop must be
  // rejected loudly here, or a variable that validates would never reach any workspace process.
  it.each([
    "MY_TOKEN",
    "TOKENIZER_PATH", // substring match, deliberately
    "SECRET_SAUCE",
    "DB_PASSWORD",
    "PASSWD_FILE",
    "AWS_CREDENTIALS",
    "SERVICE_APIKEY",
    "SIGNING_KEY",
    "API_KEY",
    "KEY",
    "key",
    "api_key",
  ])("rejects secret-looking name %s as the daemon filter would drop it", (name) => {
    expect(findWorkspaceEnvReservedRule(name)).toBe("secret-marker");
  });

  it.each(["MONKEY", "KEYBOARD_LAYOUT", "TURNKEY_MODE", "DONKEY"])(
    "allows %s — KEY only matches as suffix _KEY or the whole name",
    (name) => {
      expect(findWorkspaceEnvReservedRule(name)).toBeUndefined();
    },
  );

  it("rejects NUL in values and oversized values by name, never by content", () => {
    const nulIssues = expectIssues({ HAS_NUL: "a\u0000b" });
    expect(nulIssues).toEqual([{ rule: "value-nul", name: "HAS_NUL" }]);

    const bigIssues = expectIssues({ BIG: "x".repeat(WORKSPACE_ENV_MAX_VALUE_BYTES + 1) });
    expect(bigIssues).toEqual([
      { rule: "value-size", name: "BIG", valueBytes: WORKSPACE_ENV_MAX_VALUE_BYTES + 1 },
    ]);
  });

  it("measures value size in UTF-8 bytes, not UTF-16 code units", () => {
    // '💥' is 4 UTF-8 bytes but 2 UTF-16 code units.
    const value = "💥".repeat(WORKSPACE_ENV_MAX_VALUE_BYTES / 4 + 1);
    const issues = expectIssues({ EMOJI: value });
    expect(issues[0]?.rule).toBe("value-size");
  });

  it("accepts a value at exactly the size limit", () => {
    expect(parseWorkspaceEnv({ AT_LIMIT: "x".repeat(WORKSPACE_ENV_MAX_VALUE_BYTES) }).ok).toBe(
      true,
    );
  });

  it("enforces the entry-count and total-byte aggregates", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: WORKSPACE_ENV_MAX_ENTRIES + 1 }, (_, i) => [`VAR_${i}`, "v"]),
    );
    expect(expectIssues(tooMany)).toContainEqual({
      rule: "entry-count",
      entryCount: WORKSPACE_ENV_MAX_ENTRIES + 1,
    });

    // 9 entries × (8-byte name + 4000-byte value) = 36072 bytes > 32 KiB, under the entry cap.
    const tooBig = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`BULKY_${i}`, "v".repeat(4000)]),
    );
    const issues = expectIssues(tooBig);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("total-size");
    expect(issues[0]?.rule === "total-size" && issues[0].totalBytes).toBeGreaterThan(
      WORKSPACE_ENV_MAX_TOTAL_BYTES,
    );
  });

  it("collects every issue in one pass instead of stopping at the first", () => {
    const issues = expectIssues({
      "BAD NAME": "v",
      GITHUB_TOKEN: "v",
      HAS_NUL: "a\u0000b",
    });
    expect(issues.map((issue) => issue.rule).toSorted()).toEqual([
      "name-grammar",
      "name-reserved",
      "value-nul",
    ]);
  });

  it("formats every issue without values", () => {
    const issues = expectIssues({
      "BAD NAME": "value-a",
      MY_TOKEN: "value-b",
      HAS_NUL: "value-c\u0000",
      BIG: "value-d".repeat(1000),
    });
    for (const issue of issues) {
      const message = formatWorkspaceEnvIssue(issue);
      expect(message).not.toContain("value-");
      expect(message.length).toBeGreaterThan(10);
    }
  });
});
