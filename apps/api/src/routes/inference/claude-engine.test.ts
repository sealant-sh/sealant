import { existsSync } from "node:fs";

import { provisionClaudeKeyDir, removeClaudeConfigDir } from "@sealant/credentials";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claudeEngineLayer,
  InferenceEngine,
  InferenceEngineLive,
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
  process.env["ANTHROPIC_BASE_URL"] = fake.baseUrl;
  process.env["ANTHROPIC_API_KEY"] = ambientKey;
  process.env["DISABLE_AUTOUPDATER"] = "1";
  process.env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
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
      Effect.provide(options === undefined ? InferenceEngineLive : claudeEngineLayer(options)),
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
        claudeEngineLayer({ sessionIdleTtlMs: 3_000, sweepIntervalMs: 100 }),
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
