/**
 * The Codex inference engine — runs the exchange through the OFFICIAL Codex CLI.
 *
 * COMPLIANCE (docs/connected-accounts-design.md §2 codex, load-bearing): the stored subscription
 * credential is consumed exactly the way OpenAI documents for third parties — through the official
 * Codex runtime, pointed at a control-plane-provisioned private CODEX_HOME holding the decrypted
 * auth.json (0700 dir / 0600 file). The CLI reads the file itself AND can rotate the session with
 * its refresh token — the control plane never calls OpenAI's token endpoint. This module NEVER
 * calls a model API directly, never logs token material, and strips any ambient OPENAI_API_KEY
 * from the subprocess env so the exchange cannot silently bill a different identity than the
 * resolved connected account.
 *
 * Differences from the claude engine, both deliberate:
 * - Tool-less v1: codex has no in-process MCP transport, so caller-defined tools are rejected at
 *   the route (the park-for-results session state is unused here). Every exchange is a single
 *   spawn that settles in one turn — no session map, `inf_` session ids exist only for response
 *   shape parity.
 * - The claude engine disables built-in tools wholesale (`tools: []`); codex's shell tool cannot
 *   be disabled outright, so the compensations are `--sandbox read-only`, an empty scratch cwd,
 *   `--ephemeral` (no session files persisted), and `--ignore-user-config` (auth still comes from
 *   CODEX_HOME; nothing else does).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Effect, Layer } from "effect";

import { InferenceEngineError, type InferenceEngineTurn } from "./claude-engine.js";
import { extractJson, isAuthFailureMessage, redactSecrets } from "./support.js";

/** How long one exchange waits for the CLI to settle before the subprocess is killed. */
const EXCHANGE_TIMEOUT_MS = 5 * 60 * 1_000;
/** Bounded stderr capture — enough to diagnose, never a transcript. */
const STDERR_TAIL_LIMIT = 4_000;

// ---------------------------------------------------------------------------------------------
// Service contract (contract first; live implementation below, composed at the boundary)
// ---------------------------------------------------------------------------------------------

export interface CodexInferenceStartInput {
  /** A provisioned private home dir holding the decrypted auth.json (see @sealant/credentials). */
  readonly codexHome: string;
  /** Token material to strip from any outbound error text (from `extractCodexSecrets`). */
  readonly secrets: readonly string[];
  readonly prompt: string;
  readonly system?: string;
  /** Passed verbatim to `-m` — an opaque model id, never validated here. */
  readonly model?: string;
  readonly responseFormat?: { readonly type: "json"; readonly schema?: unknown };
  /**
   * Invoked exactly once when the exchange ends — success OR failure. Callers hook their
   * read-back-and-persist + cleanup here (the CLI may have rotated auth.json even when the
   * exchange failed). Fire-and-forget: errors are the callback's own to swallow.
   */
  readonly onSessionEnd?: () => Promise<void>;
}

export interface CodexInferenceEngineService {
  readonly start: (
    input: CodexInferenceStartInput,
  ) => Effect.Effect<InferenceEngineTurn, InferenceEngineError>;
}

export class CodexInferenceEngine extends Context.Service<
  CodexInferenceEngine,
  CodexInferenceEngineService
>()("@sealant/api/CodexInferenceEngine") {}

// ---------------------------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------------------------

/**
 * The official CLI's JS launcher, resolved the way the production bundle will resolve it (see
 * apps/api/Dockerfile's staging assert). Resolved lazily so test layers that inject a command
 * never require the package at import time.
 */
const defaultCommand = (): readonly string[] => {
  const require = createRequire(import.meta.url);
  return [process.execPath, require.resolve("@openai/codex/bin/codex.js")];
};

/** Subprocess env: ambient OpenAI identities stripped, the provisioned home injected. */
const buildEnv = (codexHome: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  // An ambient key would shadow the auth.json and bill a different identity; an ambient base URL
  // would point the official runtime somewhere other than OpenAI. Both are stripped.
  delete env["OPENAI_API_KEY"];
  delete env["OPENAI_BASE_URL"];
  env["CODEX_HOME"] = codexHome;
  return env;
};

interface ParsedExchange {
  text: string | undefined;
  usage: { inputTokens: number; outputTokens: number } | undefined;
  errorDetail: string | undefined;
}

/** Folds one `--json` JSONL stdout line into the exchange state. Unknown events are ignored. */
const foldEventLine = (state: ParsedExchange, line: string): void => {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof event !== "object" || event === null) {
    return;
  }
  const record = event as Record<string, unknown>;

  if (record.type === "item.completed") {
    const item = record.item;
    if (typeof item === "object" && item !== null) {
      const itemRecord = item as Record<string, unknown>;
      if (itemRecord.type === "agent_message" && typeof itemRecord.text === "string") {
        state.text = itemRecord.text;
      }
    }
    return;
  }

  if (record.type === "turn.completed") {
    const usage = record.usage;
    if (typeof usage === "object" && usage !== null) {
      const usageRecord = usage as Record<string, unknown>;
      const inputTokens = usageRecord.input_tokens;
      const outputTokens = usageRecord.output_tokens;
      if (typeof inputTokens === "number" && typeof outputTokens === "number") {
        state.usage = { inputTokens, outputTokens };
      }
    }
    return;
  }

  // Failure-shaped events carry a message; capture the last one for the error text.
  if (
    (record.type === "turn.failed" || record.type === "error") &&
    typeof record.message === "string"
  ) {
    state.errorDetail = record.message;
  }
};

const startExchange = async (
  input: CodexInferenceStartInput,
  command: readonly string[],
  timeoutMs: number,
): Promise<InferenceEngineTurn> => {
  const sessionId = `inf_${randomUUID()}`;

  // Empty scratch cwd: the sandboxed shell tool has nothing to read, and the schema file (when
  // native structured output is requested) lives — and dies — with it.
  const scratchDir = mkdtempSync(join(tmpdir(), "sealant-codex-cwd-"));

  const useNativeStructuredOutput =
    input.responseFormat?.type === "json" &&
    typeof input.responseFormat.schema === "object" &&
    input.responseFormat.schema !== null;
  const jsonByInstruction = input.responseFormat?.type === "json" && !useNativeStructuredOutput;

  // No headless system-prompt flag exists; the system text is prepended to the prompt (verified
  // faithful for inference-sized prompts; a config-override mechanism can replace this later).
  const prompt = [
    ...(input.system === undefined ? [] : [input.system]),
    ...(jsonByInstruction
      ? [
          "Respond ONLY with a single valid JSON value — no prose, no markdown fences around anything else.",
        ]
      : []),
    input.prompt,
  ].join("\n\n");

  let schemaPath: string | undefined;
  if (useNativeStructuredOutput) {
    schemaPath = join(scratchDir, "output-schema.json");
    writeFileSync(schemaPath, JSON.stringify(input.responseFormat?.schema), { mode: 0o600 });
  }

  const [executable, ...leadingArgs] = command;
  if (executable === undefined) {
    throw new InferenceEngineError("engine", "Codex engine misconfigured: empty command.");
  }
  const args = [
    ...leadingArgs,
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-C",
    scratchDir,
    ...(input.model === undefined ? [] : ["-m", input.model]),
    ...(schemaPath === undefined ? [] : ["--output-schema", schemaPath]),
    prompt,
  ];

  try {
    return await new Promise<InferenceEngineTurn>((resolve, reject) => {
      const state: ParsedExchange = { text: undefined, usage: undefined, errorDetail: undefined };
      let stderrTail = "";
      let stdoutBuffer = "";
      let settled = false;

      const child = spawn(executable, args, {
        env: buildEnv(input.codexHome),
        cwd: scratchDir,
        // Closed stdin: the CLI treats piped stdin as extra prompt input.
        stdio: ["ignore", "pipe", "pipe"],
      });

      const fail = (error: InferenceEngineError): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      };

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        fail(
          new InferenceEngineError(
            "timeout",
            `Codex inference timed out after ${timeoutMs / 1_000}s.`,
          ),
        );
      }, timeoutMs);
      timeout.unref?.();

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        for (;;) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline === -1) {
            break;
          }
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line.length > 0) {
            foldEventLine(state, line);
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });

      child.on("error", (error) => {
        fail(
          new InferenceEngineError("engine", `Failed to spawn the Codex CLI: ${error.message}`, {
            cause: error,
          }),
        );
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);

        if (stdoutBuffer.trim().length > 0) {
          foldEventLine(state, stdoutBuffer.trim());
        }

        if (code === 0 && state.text !== undefined) {
          const json = useNativeStructuredOutput
            ? safeParseJson(state.text)
            : jsonByInstruction
              ? extractJson(state.text)
              : undefined;
          resolve({
            sessionId,
            turn: {
              type: "done",
              text: state.text,
              ...(json === undefined ? {} : { json }),
              ...(state.usage === undefined ? {} : { usage: state.usage }),
            },
          });
          return;
        }

        const detail =
          state.errorDetail ??
          (stderrTail.trim().length > 0
            ? stderrTail.trim()
            : `Codex CLI exited with code ${code ?? "unknown"} without producing a result.`);
        const message = redactSecrets(`Codex inference failed: ${detail}`, input.secrets);
        reject(
          new InferenceEngineError(isAuthFailureMessage(message) ? "auth" : "engine", message),
        );
      });
    });
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Best-effort: a leaked scratch dir never fails the exchange that owned it.
    }
    if (input.onSessionEnd !== undefined) {
      void input.onSessionEnd().catch((error: unknown) => {
        console.warn("Codex inference onSessionEnd hook failed", { error });
      });
    }
  }
};

/** The CLI already validated against the schema; a parse failure degrades to text-only. */
const safeParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const toEngineError = (error: unknown, secrets: readonly string[]): InferenceEngineError => {
  if (error instanceof InferenceEngineError) {
    return error;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactSecrets(raw, secrets);
  return isAuthFailureMessage(message)
    ? new InferenceEngineError("auth", message, { cause: error })
    : new InferenceEngineError("engine", message, { cause: error });
};

/**
 * Build the live layer. `command` overrides the spawned executable + leading args and `timeoutMs`
 * the exchange deadline (tests inject a fixture script and a short deadline); the defaults
 * resolve the pinned `@openai/codex` launcher and the production timeout.
 */
export const codexEngineLayer = (options?: {
  readonly command?: readonly string[];
  readonly timeoutMs?: number;
}): Layer.Layer<CodexInferenceEngine> =>
  Layer.succeed(CodexInferenceEngine, {
    start: (input) =>
      Effect.tryPromise({
        try: () =>
          startExchange(
            input,
            options?.command ?? defaultCommand(),
            options?.timeoutMs ?? EXCHANGE_TIMEOUT_MS,
          ),
        catch: (error) => toEngineError(error, input.secrets),
      }),
  });

export const CodexInferenceEngineLive: Layer.Layer<CodexInferenceEngine> = codexEngineLayer();
