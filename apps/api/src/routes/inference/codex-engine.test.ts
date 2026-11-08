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
type FakeMode = "echo" | "fail" | "auth" | "turn-failed" | "hang";

let codexHome: string;

const hostOnly = {
  OPENAI_API_KEY: "sk-proj-FAKEambientkeythatmustnotleak0000",
  OPENAI_BASE_URL: "http://elsewhere.invalid",
  SEALANT_CREDENTIALS_KEY: "FAKEhostcipherkey",
  AWS_ACCESS_KEY_ID: "AKIAFAKEHOSTCLOUDKEY",
};

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "codex-engine-test-"));
  Object.assign(process.env, hostOnly);
});

afterEach(() => {
  rmSync(codexHome, { recursive: true, force: true });
  for (const name of Object.keys(hostOnly)) delete process.env[name];
});

const start = (
  mode: FakeMode,
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
          command: [process.execPath, fixturePath, `--fake-mode=${mode}`],
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }),
      ),
    ),
  );

const startExpectingFailure = (
  mode: FakeMode,
  input: Partial<CodexInferenceStartInput>,
  options?: { readonly timeoutMs?: number },
): Promise<InferenceEngineError> =>
  start(mode, input, options).then(
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
    let sessionEnds = 0;

    const result = await start("echo", {
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
      home: string | null;
      env: string[];
    };
    expect(echoed.codexHome).toBe(codexHome);
    expect(echoed.home).toBe(codexHome);
    for (const name of Object.keys(hostOnly)) {
      expect(echoed.env).not.toContain(name);
    }
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
    let sessionEnds = 0;

    const error = await startExpectingFailure("fail", {
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

  it("answers a failed turn with its own words, redacted", async () => {
    const error = await startExpectingFailure("turn-failed", {
      secrets: ["sk-secret-token-value"],
    });

    expect(error).toMatchObject({
      reason: "engine",
      message:
        "Codex inference failed: stream disconnected before completion: quota for [redacted]",
    });
  });

  it("classifies a 401-shaped stderr as auth words, with no status", async () => {
    const error = await startExpectingFailure("auth", {});
    expect(error.reason).toBe("auth-words");
  });

  it("kills the subprocess and fails with reason 'timeout' past the deadline", async () => {
    const error = await startExpectingFailure("hang", {}, { timeoutMs: 300 });
    expect(error.reason).toBe("timeout");
  });
});
