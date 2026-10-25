/**
 * The Claude engine against the real Claude Code CLI the pinned Agent SDK ships, talking to a local
 * fake Anthropic API (never a real endpoint, never a real key).
 */
import { provisionClaudeKeyDir, removeClaudeConfigDir } from "@sealant/credentials";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { InferenceEngine, InferenceEngineLive, type InferenceStartInput } from "./claude-engine.js";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.fixture.js";

const apiKey = "sk-ant-api03-FAKEenginekeyforthetests00000000000a1b2";
const ambientKey = "sk-ant-api03-FAKEambientkeythatmustnotbeused0000zzzz";

let fake: FakeAnthropic;

beforeAll(async () => {
  fake = await startFakeAnthropic();
  process.env["ANTHROPIC_BASE_URL"] = fake.baseUrl;
  process.env["ANTHROPIC_API_KEY"] = ambientKey;
  process.env["DISABLE_AUTOUPDATER"] = "1";
  process.env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.reset();
});

const keyStart = (): InferenceStartInput & { readonly configDir: string } => {
  const provisioned = provisionClaudeKeyDir({ apiKey });
  return {
    configDir: provisioned.configDir,
    auth: {
      kind: "api-key",
      configDir: provisioned.configDir,
      keyPath: provisioned.keyPath,
      apiKey,
    },
    onSessionEnd: () => Promise.resolve(removeClaudeConfigDir(provisioned.configDir)),
    prompt: "hello",
    tools: [],
  };
};

const start = (input: InferenceStartInput) =>
  Effect.runPromise(
    Effect.flatMap(InferenceEngine, (engine) => engine.start(input)).pipe(
      Effect.provide(InferenceEngineLive),
    ),
  );

describe("claude engine on an API key", () => {
  it("sends the key from its helper, never an ambient environment key", async () => {
    fake.reply({ type: "text", text: "answered on a key" });

    const turn = await start(keyStart());

    expect(turn.turn).toMatchObject({ type: "done", text: "answered on a key" });
    expect(fake.apiKeys.length).toBeGreaterThan(0);
    expect(new Set(fake.apiKeys)).toEqual(new Set([apiKey]));
  }, 60_000);
});
