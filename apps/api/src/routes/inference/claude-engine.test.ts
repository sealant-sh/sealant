import { existsSync } from "node:fs";

import { provisionClaudeKeyDir, removeClaudeConfigDir } from "@sealant/credentials";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claudeEngineLayer,
  InferenceEngine,
  type ClaudeEngineOptions,
  type InferenceStartInput,
} from "./claude-engine.js";
import { openExchange } from "./exchange.js";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.fixture.js";

const apiKey = "sk-ant-api03-FAKEenginekeyforthetests00000000000a1b2";
const ambientKey = "sk-ant-api03-FAKEambientkeythatmustnotbeused0000zzzz";

let fake: FakeAnthropic;
const configDirs: string[] = [];

beforeEach(async () => {
  fake = await startFakeAnthropic();
  process.env["ANTHROPIC_API_KEY"] = ambientKey;
});

afterEach(async () => {
  await expect
    .poll(() => configDirs.filter((dir) => existsSync(dir)), { timeout: 10_000 })
    .toEqual([]);
  await fake.close();
});

const keyStart = (): InferenceStartInput & { readonly configDir: string } => {
  const provisioned = provisionClaudeKeyDir({ apiKey });
  configDirs.push(provisioned.configDir);
  return {
    configDir: provisioned.configDir,
    exchange: openExchange({
      ownerUserId: "usr_1",
      receipt: { accountId: "cacc_key", revision: 1, login: "api-key" },
      login: { shape: "claude-key", apiKey },
    }),
    auth: { kind: "api-key", configDir: provisioned.configDir, keyPath: provisioned.keyPath },
    onSessionEnd: () => Promise.resolve(removeClaudeConfigDir(provisioned.configDir)),
    prompt: "hello",
    tools: [],
  };
};

const start = (input: InferenceStartInput, options?: ClaudeEngineOptions) =>
  Effect.runPromise(
    Effect.flatMap(InferenceEngine, (engine) => engine.start(input)).pipe(
      Effect.provide(claudeEngineLayer({ anthropicBaseUrl: fake.baseUrl, ...options })),
    ),
  );

const searchTool = { name: "search", inputSchema: { type: "object" } };

const refusingQuery: NonNullable<ClaudeEngineOptions["query"]> = () => {
  throw new Error("the SDK refused its options");
};

describe("claude engine on an API key", () => {
  it("sends the key from its helper, never an ambient environment key", async () => {
    fake.reply({ type: "text", text: "answered on a key" });

    const turn = await start(keyStart());

    expect(turn.turn).toMatchObject({ type: "done", text: "answered on a key" });
    expect(fake.apiKeys.length).toBeGreaterThan(0);
    expect(new Set(fake.apiKeys)).toEqual(new Set([apiKey]));
  }, 60_000);
});

describe("claude engine cleanup", () => {
  it("removes the key dir when the exchange answers", async () => {
    const input = keyStart();
    await start(input);
    await expect.poll(() => existsSync(input.configDir), { timeout: 10_000 }).toBe(false);
  }, 60_000);

  it("removes the key dir when the exchange fails", async () => {
    fake.reply({ type: "status", status: 400, errorType: "invalid_request_error" });
    const input = keyStart();
    await expect(start(input)).rejects.toMatchObject({ reason: "engine" });
    await expect.poll(() => existsSync(input.configDir), { timeout: 10_000 }).toBe(false);
  }, 60_000);

  it("removes the key dir when a turn times out", async () => {
    fake.reply({ type: "hang" });
    const input = keyStart();
    await expect(start(input, { turnTimeoutMs: 2_000 })).rejects.toMatchObject({
      reason: "timeout",
    });
    await expect.poll(() => existsSync(input.configDir), { timeout: 10_000 }).toBe(false);
  }, 60_000);

  it("releases the key dir and the exchange when a parked exchange expires idle", async () => {
    fake.reply({ type: "toolUse", name: "mcp__caller__search", input: { q: "x" } });
    const input = { ...keyStart(), tools: [searchTool] };
    const engine = Effect.runSync(
      Effect.provide(
        InferenceEngine,
        claudeEngineLayer({
          anthropicBaseUrl: fake.baseUrl,
          sessionIdleTtlMs: 3_000,
          sweepIntervalMs: 100,
        }),
      ),
    );

    const turn = await Effect.runPromise(engine.start(input));
    const held = engine.exchange(turn.sessionId);

    expect(turn.turn).toMatchObject({ type: "toolCalls", calls: [{ name: "search" }] });
    expect(held).toBe(input.exchange);
    await expect.poll(() => existsSync(input.configDir), { timeout: 10_000 }).toBe(false);
    expect(engine.exchange(turn.sessionId)).toBeUndefined();
  }, 60_000);

  it("removes the key dir when the exchange cannot be started", async () => {
    const input = keyStart();
    await expect(start(input, { query: refusingQuery })).rejects.toMatchObject({
      reason: "engine",
    });
    await expect.poll(() => existsSync(input.configDir), { timeout: 10_000 }).toBe(false);
  });
});

describe("claude engine environment", () => {
  const hostOnly = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_CUSTOM_HEADERS: "x-leak: 1",
    AWS_ACCESS_KEY_ID: "AKIAFAKEHOSTCLOUDKEY",
    SEALANT_CREDENTIALS_KEY: "FAKEhostcipherkey",
    SEALANT_DATABASE_URL: "postgres://FAKE@host/db",
  };

  afterEach(() => {
    for (const name of Object.keys(hostOnly)) delete process.env[name];
    delete process.env["HTTPS_PROXY"];
  });

  it("hands the CLI its own login and the host's path, locale and proxy, nothing else", async () => {
    Object.assign(process.env, hostOnly, {
      ANTHROPIC_BASE_URL: "http://elsewhere.invalid",
      HTTPS_PROXY: "http://proxy.invalid:3128",
    });
    let env: Record<string, string | undefined> | undefined;
    const capturing: NonNullable<ClaudeEngineOptions["query"]> = (params) => {
      env = params.options?.env;
      throw new Error("captured");
    };
    const input = keyStart();

    await expect(
      start(input, { query: capturing, anthropicBaseUrl: "http://fake.invalid" }),
    ).rejects.toMatchObject({ reason: "engine" });

    expect(env).toMatchObject({
      HOME: input.configDir,
      CLAUDE_CONFIG_DIR: input.configDir,
      ANTHROPIC_BASE_URL: "http://fake.invalid",
      HTTPS_PROXY: "http://proxy.invalid:3128",
      PATH: process.env["PATH"],
    });
    for (const name of [...Object.keys(hostOnly), "ANTHROPIC_API_KEY"]) {
      expect(env).not.toHaveProperty(name);
    }
  });
});
