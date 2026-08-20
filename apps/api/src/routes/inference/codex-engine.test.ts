/**
 * Codex-engine tests against a fake CLI fixture (fake-codex.fixture.mjs) that emits the real
 * `codex exec --json` JSONL shapes. The echo mode reports argv/env back through the agent message,
 * so one exchange asserts the whole spawn contract: flags, sandbox, model passthrough, schema
 * file, CODEX_HOME injection, and ambient-identity stripping.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InferenceEngineError, type InferenceEngineTurn } from "./claude-engine.js";
import {
  CodexInferenceEngine,
  codexEngineLayer,
  type CodexInferenceStartInput,
} from "./codex-engine.js";

const fixturePath = fileURLToPath(new URL("./fake-codex.fixture.mjs", import.meta.url));
const fixtureCommand = [process.execPath, fixturePath];

let codexHome: string;

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "codex-engine-test-"));
  // The engine passes ambient env through minus OpenAI identities; the fixture reads both.
  process.env["OPENAI_API_KEY"] = "ambient-key-must-not-leak";
});

afterEach(() => {
  rmSync(codexHome, { recursive: true, force: true });
  delete process.env["FAKE_CODEX_MODE"];
  delete process.env["OPENAI_API_KEY"];
});

const start = (
  input: Partial<CodexInferenceStartInput>,
  options?: { readonly timeoutMs?: number },
): Promise<InferenceEngineTurn> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* CodexInferenceEngine;
      return yield* engine.start({
        codexHome,
        secrets: [],
        prompt: "name this session",
        ...input,
      });
    }).pipe(
      Effect.provide(
        codexEngineLayer({
          command: fixtureCommand,
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }),
      ),
    ),
  );

const startExpectingFailure = (
  input: Partial<CodexInferenceStartInput>,
  options?: { readonly timeoutMs?: number },
): Promise<InferenceEngineError> =>
  start(input, options).then(
    (turn) => {
      throw new Error(`expected a failure, got turn ${JSON.stringify(turn.turn.type)}`);
    },
    (error: unknown) => {
      // runPromise rejects with the typed failure (possibly wrapped); unwrap via cause chain.
      let current: unknown = error;
      while (current !== undefined && !(current instanceof InferenceEngineError)) {
        current = current instanceof Error ? current.cause : undefined;
      }
      if (current instanceof InferenceEngineError) {
        return current;
      }
      throw error;
    },
  );

/** Waits for the fire-and-forget end-of-session hook to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("codex engine", () => {
  it("maps a successful exchange to a done turn with text, json, and usage", async () => {
    process.env["FAKE_CODEX_MODE"] = "echo";
    let sessionEnds = 0;

    const result = await start({
      model: "lunna",
      system: "You name coding sessions.",
      responseFormat: {
        type: "json",
        schema: { type: "object", properties: { argv: { type: "array" } } },
      },
      onSessionEnd: () => {
        sessionEnds += 1;
        return Promise.resolve();
      },
    });

    expect(result.sessionId.startsWith("inf_")).toBe(true);
    expect(result.turn.type).toBe("done");
    if (result.turn.type !== "done") {
      return;
    }
    expect(result.turn.usage).toEqual({ inputTokens: 12, outputTokens: 3 });

    // The fixture echoes its argv/env: assert the spawn contract in one pass.
    const echoed = result.turn.json as {
      argv: string[];
      codexHome: string | null;
      openaiApiKey: string | null;
    };
    expect(echoed.codexHome).toBe(codexHome);
    // Ambient OpenAI identity is stripped — the exchange may only bill the provisioned account.
    expect(echoed.openaiApiKey).toBeNull();
    for (const flag of [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--output-schema",
    ]) {
      expect(echoed.argv).toContain(flag);
    }
    expect(echoed.argv).toContain("-m");
    expect(echoed.argv).toContain("lunna");
    expect(echoed.argv[echoed.argv.indexOf("--sandbox") + 1]).toBe("read-only");
    // System text rides the prompt (no headless system flag exists).
    const prompt = echoed.argv[echoed.argv.length - 1] ?? "";
    expect(prompt.startsWith("You name coding sessions.")).toBe(true);
    expect(prompt.endsWith("name this session")).toBe(true);

    // The end-of-session hook fires exactly once, on success too (read-back + cleanup).
    await settle();
    expect(sessionEnds).toBe(1);
  });

  it("fails with reason 'engine' and redacts secrets on a nonzero exit", async () => {
    process.env["FAKE_CODEX_MODE"] = "fail";
    let sessionEnds = 0;

    const error = await startExpectingFailure({
      secrets: ["sk-secret-token-value"],
      onSessionEnd: () => {
        sessionEnds += 1;
        return Promise.resolve();
      },
    });

    expect(error.reason).toBe("engine");
    expect(error.message).toContain("boom");
    expect(error.message).not.toContain("sk-secret-token-value");
    expect(error.message).toContain("[redacted]");

    // The end-of-session hook fires on failure too.
    await settle();
    expect(sessionEnds).toBe(1);
  });

  it("classifies a 401-shaped stderr as an auth failure", async () => {
    process.env["FAKE_CODEX_MODE"] = "auth";
    const error = await startExpectingFailure({});
    expect(error.reason).toBe("auth");
  });

  it("kills the subprocess and fails with reason 'timeout' past the deadline", async () => {
    process.env["FAKE_CODEX_MODE"] = "hang";
    const error = await startExpectingFailure({}, { timeoutMs: 300 });
    expect(error.reason).toBe("timeout");
  });
});
