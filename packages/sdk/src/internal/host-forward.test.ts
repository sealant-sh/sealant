import { describe, expect, it, vi } from "vitest";

import { prepareForward, resolveHostForward, type HostForwardDeps } from "./host-forward.js";

const makeDeps = (overrides: Partial<HostForwardDeps> = {}): HostForwardDeps => ({
  hostEnv: {},
  exec: () => Promise.reject(new Error("exec not stubbed")),
  readTextFile: () => Promise.reject(new Error("ENOENT")),
  homeDir: "/home/dev",
  platform: "linux",
  warn: () => {},
  ...overrides,
});

/** A fake `readTextFile` that resolves `contents` only for `expectedPath`, else rejects (proves path). */
const fileReader =
  (expectedPath: string, contents: string): HostForwardDeps["readTextFile"] =>
  (path) =>
    path === expectedPath
      ? Promise.resolve(contents)
      : Promise.reject(new Error(`unexpected path ${path}`));

/** A fake `exec` for `gh auth token`. */
const ghExec =
  (token: string): HostForwardDeps["exec"] =>
  (command) =>
    command === "gh"
      ? Promise.resolve(token)
      : Promise.reject(new Error(`unexpected exec ${command}`));

/** A fake `exec` for macOS `security find-generic-password -s <service> -w`. */
const keychainExec =
  (service: string, value: string): HostForwardDeps["exec"] =>
  (command, args) =>
    command === "security" && args[2] === service
      ? Promise.resolve(value)
      : Promise.reject(new Error(`unexpected exec ${command} ${args.join(" ")}`));

const decodeB64 = (value: string): string => Buffer.from(value, "base64").toString("utf8");

describe("resolveHostForward — gh (env token)", () => {
  it("captures GH_TOKEN from `gh auth token`", async () => {
    const resolved = await resolveHostForward(["gh"], makeDeps({ exec: ghExec("ghp_abc123\n") }));
    expect(resolved.captures[0]?.capture.env).toEqual({ GH_TOKEN: "ghp_abc123" });
    expect(resolved.captures[0]?.capture.files).toBeUndefined();
    expect(resolved.skips).toHaveLength(0);
  });

  it("skips when gh is missing / not logged in", async () => {
    const resolved = await resolveHostForward(["gh"], makeDeps());
    expect(resolved.captures).toHaveLength(0);
    expect(resolved.skips[0]?.reason).toMatch(/gh auth login/);
  });
});

describe("resolveHostForward — claude-code (subscription)", () => {
  it("prefers explicit env tokens when present", async () => {
    const resolved = await resolveHostForward(
      ["claude-code"],
      makeDeps({ hostEnv: { CLAUDE_CODE_OAUTH_TOKEN: "oat", ANTHROPIC_API_KEY: "sk-ant" } }),
    );
    expect(resolved.captures[0]?.capture.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "oat",
      ANTHROPIC_API_KEY: "sk-ant",
    });
    expect(resolved.captures[0]?.capture.files).toBeUndefined();
  });

  it("forwards the on-disk subscription credentials file (Linux)", async () => {
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } });
    const resolved = await resolveHostForward(
      ["claude-code"],
      makeDeps({ readTextFile: fileReader("/home/dev/.claude/.credentials.json", creds) }),
    );
    const file = resolved.captures[0]?.capture.files?.[0];
    expect(file?.path).toBe("/root/.claude/.credentials.json");
    expect(file?.mode).toBe("600");
    expect(file?.content).toBe(creds);
  });

  it("extracts subscription credentials from the macOS Keychain when there is no file", async () => {
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: "a" } });
    const resolved = await resolveHostForward(
      ["claude-code"],
      makeDeps({ platform: "darwin", exec: keychainExec("Claude Code-credentials", creds) }),
    );
    expect(resolved.captures[0]?.capture.files?.[0]?.content).toBe(creds);
  });

  it("honors CLAUDE_CONFIG_DIR when locating the credentials file", async () => {
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: "a" } });
    const resolved = await resolveHostForward(
      ["claude-code"],
      makeDeps({
        hostEnv: { CLAUDE_CONFIG_DIR: "/cfg/claude" },
        readTextFile: fileReader("/cfg/claude/.credentials.json", creds),
      }),
    );
    expect(resolved.captures[0]?.capture.files?.[0]?.content).toBe(creds);
  });

  it("skips when there is no Claude auth anywhere", async () => {
    const resolved = await resolveHostForward(["claude-code"], makeDeps());
    expect(resolved.captures).toHaveLength(0);
    expect(resolved.skips[0]?.reason).toMatch(/claude \/login/);
  });
});

describe("resolveHostForward — codex (subscription)", () => {
  it("prefers OPENAI_API_KEY from the env", async () => {
    const resolved = await resolveHostForward(
      ["codex"],
      makeDeps({ hostEnv: { OPENAI_API_KEY: "sk-oai" } }),
    );
    expect(resolved.captures[0]?.capture.env).toEqual({ OPENAI_API_KEY: "sk-oai" });
    expect(resolved.captures[0]?.capture.files).toBeUndefined();
  });

  it("forwards ~/.codex/auth.json and warns about refresh-token rotation", async () => {
    const auth = JSON.stringify({ OPENAI_API_KEY: null, tokens: { refresh_token: "r" } });
    const resolved = await resolveHostForward(
      ["codex"],
      makeDeps({ readTextFile: fileReader("/home/dev/.codex/auth.json", auth) }),
    );
    const cap = resolved.captures[0]?.capture;
    expect(cap?.files?.[0]?.path).toBe("/root/.codex/auth.json");
    expect(cap?.files?.[0]?.content).toBe(auth);
    expect(cap?.warning).toMatch(/rotating single-use refresh token/);
  });

  it("honors CODEX_HOME when locating auth.json", async () => {
    const auth = JSON.stringify({ tokens: { refresh_token: "r" } });
    const resolved = await resolveHostForward(
      ["codex"],
      makeDeps({
        hostEnv: { CODEX_HOME: "/custom/codex" },
        readTextFile: fileReader("/custom/codex/auth.json", auth),
      }),
    );
    expect(resolved.captures[0]?.capture.files?.[0]?.content).toBe(auth);
  });

  it("skips when codex is not logged in", async () => {
    const resolved = await resolveHostForward(["codex"], makeDeps());
    expect(resolved.captures).toHaveLength(0);
    expect(resolved.skips[0]?.reason).toMatch(/codex login/);
  });
});

describe("resolveHostForward — de-dup", () => {
  it("queries each tool at most once, preserving order", async () => {
    const exec = vi.fn(ghExec("tok\n"));
    const resolved = await resolveHostForward(["gh", "gh"], makeDeps({ exec }));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(resolved.captures).toHaveLength(1);
  });
});

describe("prepareForward — plan assembly", () => {
  it("materializes a credential file as a base64 env var + a decode boot step", async () => {
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } });
    const plan = await prepareForward(
      { forward: ["claude-code"] },
      makeDeps({ readTextFile: fileReader("/home/dev/.claude/.credentials.json", creds) }),
    );

    expect(plan.env.SEALANT_FWD_CLAUDE_CODE_0).toBeDefined();
    expect(decodeB64(plan.env.SEALANT_FWD_CLAUDE_CODE_0!)).toBe(creds);
    expect(plan.setupSteps).toEqual([
      {
        run: 'mkdir -p /root/.claude && printf %s "$SEALANT_FWD_CLAUDE_CODE_0" | base64 -d > /root/.claude/.credentials.json && chmod 600 /root/.claude/.credentials.json',
        shell: "bash",
      },
    ]);
    // The secret bytes ride ONLY in the env var, never inside the (image-baked) boot command.
    expect(plan.setupSteps[0]?.run).not.toContain(creds);
  });

  it("layers explicit env over forwarded captures and emits skip + caveat warnings", async () => {
    const warn = vi.fn();
    const plan = await prepareForward(
      { forward: ["gh", "codex", "claude-code"], env: { GH_TOKEN: "explicit" } },
      makeDeps({
        exec: ghExec("ghp_forwarded\n"),
        readTextFile: fileReader("/home/dev/.codex/auth.json", JSON.stringify({ tokens: {} })),
        warn,
      }),
    );

    expect(plan.env.GH_TOKEN).toBe("explicit"); // explicit wins over the forwarded gh token
    expect(plan.env.SEALANT_FWD_CODEX_0).toBeDefined(); // codex auth.json materialized
    // claude-code had no auth → one skip warning; codex → one rotation caveat warning.
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => /forward "claude-code".*skipped/.test(m))).toBe(true);
    expect(messages.some((m) => /forward "codex".*rotating/.test(m))).toBe(true);
  });

  it("returns an empty plan when neither forward nor env is set", async () => {
    const plan = await prepareForward({}, makeDeps());
    expect(plan).toEqual({ env: {}, setupSteps: [] });
  });

  it("passes explicit env through even without forward", async () => {
    const plan = await prepareForward({ env: { A: "b" } }, makeDeps());
    expect(plan.env).toEqual({ A: "b" });
    expect(plan.setupSteps).toHaveLength(0);
  });
});
