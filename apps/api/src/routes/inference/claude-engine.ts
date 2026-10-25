/**
 * The Claude inference engine — runs the exchange through the OFFICIAL Claude Agent SDK.
 *
 * COMPLIANCE (docs/connected-accounts-design.md §2/§9, load-bearing): the stored subscription
 * credential is consumed exactly the way Anthropic documents for third parties — through the
 * environment of the official Claude Code runtime, which the Agent SDK spawns and drives. Every
 * exchange runs with a private per-invocation directory as both `CLAUDE_CONFIG_DIR` and `HOME`,
 * holding no login but the resolved account's: setup tokens ride `CLAUDE_CODE_OAUTH_TOKEN` over an
 * empty one; session credential files are materialized into it (0700 dir / 0600 file) so the
 * official CLI reads the file itself AND can rotate the session with its refresh token — the
 * control plane never calls Anthropic's token endpoint. This module NEVER calls a model API
 * directly, never logs the token, and builds the subprocess env from an allowlist
 * ({@link providerCliEnv}), so no ambient key, cloud-provider switch or base URL can make the
 * exchange bill a different identity than the resolved connected account.
 *
 * Caller-defined tools are exposed to the model through an in-process MCP server registered with
 * the caller's JSON schemas VERBATIM (the low-level @modelcontextprotocol/sdk server — the agent
 * SDK's `tool()` helper would force a Zod re-modeling). Tool handlers PARK on the session state
 * until the caller posts results over HTTP — that is the caller-executed multi-turn tool loop.
 * Built-in Claude Code tools are disabled wholesale (`tools: []`): this endpoint is inference, not
 * an agent workspace, and nothing may touch the control plane's filesystem or network on the
 * model's behalf.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import {
  query,
  type SDKAssistantMessageError,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Context, Effect, Layer } from "effect";

import type { Exchange } from "./exchange.js";
import {
  InferenceSessionState,
  SessionTurnTimeoutError,
  type SessionTurn,
  type ToolResultInput,
} from "./session-state.js";
import { extractJson, providerCliEnv, redactSecrets, soundsLikeAuthFailure } from "./support.js";

const CALLER_SERVER_NAME = "caller";
const DEFAULT_MAX_TURNS = 16;
/** How long one respond call waits for the model's next turn before giving up. */
const TURN_TIMEOUT_MS = 5 * 60 * 1_000;
/** Idle sessions (caller never posted tool results back) are reaped after this. */
const SESSION_IDLE_TTL_MS = 10 * 60 * 1_000;
const SWEEP_INTERVAL_MS = 60 * 1_000;

// ---------------------------------------------------------------------------------------------
// Service contract (contract first; live implementation below, composed at the boundary)
// ---------------------------------------------------------------------------------------------

export interface InferenceToolDefinition {
  readonly name: string;
  readonly description?: string | undefined;
  /** JSON Schema, passed to the model verbatim. */
  readonly inputSchema: unknown;
}

/**
 * How the exchange authenticates the official Claude Code runtime. Secrets are used ONLY for the
 * subprocess env (or the config dir the caller provisioned); never logged. Every variant carries
 * the caller's private `configDir`, which the CLI also gets as `HOME`: without it a refused login
 * falls back to the API host's own `~/.claude` login.
 */
export type InferenceAuth =
  | {
      /** Setup-token accounts: the documented `CLAUDE_CODE_OAUTH_TOKEN` env path. */
      readonly kind: "oauth-token";
      readonly configDir: string;
      readonly oauthToken: string;
    }
  | {
      /**
       * Session-file accounts: a caller-provisioned private config dir holding the decrypted
       * .credentials.json; the CLI reads it via `CLAUDE_CONFIG_DIR` and can rotate the session
       * in place.
       */
      readonly kind: "config-dir";
      readonly configDir: string;
    }
  | {
      readonly kind: "api-key";
      readonly configDir: string;
      readonly keyPath: string;
    };

export interface InferenceStartInput {
  /** Held by the live session until it ends; its secrets are redacted from engine errors. */
  readonly exchange: Exchange;
  readonly auth: InferenceAuth;
  readonly prompt: string;
  readonly system?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly tools: readonly InferenceToolDefinition[];
  readonly responseFormat?: { readonly type: "json"; readonly schema?: unknown };
  /**
   * Invoked exactly once when the session ends — result delivered, engine failure, OR idle
   * expiry. Config-dir callers hook their read-back-and-persist + cleanup here (the CLI may have
   * rotated the session file even when the exchange failed). Fire-and-forget: errors are the
   * callback's own to swallow; they never affect the exchange result.
   */
  readonly onSessionEnd?: () => Promise<void>;
}

export interface InferenceContinueInput {
  readonly sessionId: string;
  readonly toolResults: readonly {
    readonly toolCallId: string;
    readonly content: string;
    readonly isError?: boolean | undefined;
  }[];
}

export interface InferenceEngineTurn {
  readonly sessionId: string;
  readonly turn: SessionTurn;
}

export class InferenceEngineError extends Error {
  override readonly name = "InferenceEngineError";
  readonly reason:
    | "auth-401"
    | "auth-words"
    | "session-not-found"
    | "bad-tool-result"
    | "timeout"
    | "engine";
  constructor(
    reason: InferenceEngineError["reason"],
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.reason = reason;
  }
}

export interface InferenceEngineService {
  /** The exchange a live session runs, until the session ends. */
  readonly exchange: (sessionId: string) => Exchange | undefined;
  readonly start: (
    input: InferenceStartInput,
  ) => Effect.Effect<InferenceEngineTurn, InferenceEngineError>;
  readonly continueSession: (
    input: InferenceContinueInput,
  ) => Effect.Effect<InferenceEngineTurn, InferenceEngineError>;
}

export class InferenceEngine extends Context.Service<InferenceEngine, InferenceEngineService>()(
  "@sealant/api/InferenceEngine",
) {}

// ---------------------------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------------------------

/**
 * An MCP server exposing the caller's tools with their JSON schemas verbatim. Handlers park on the
 * session until the caller posts results back over HTTP.
 */
const buildCallerToolServer = (
  state: InferenceSessionState,
  tools: readonly InferenceToolDefinition[],
): McpServer => {
  const server = new McpServer(
    { name: CALLER_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema:
        typeof tool.inputSchema === "object" && tool.inputSchema !== null
          ? (tool.inputSchema as Record<string, unknown>)
          : { type: "object" },
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result: ToolResultInput = await state.park(
      request.params.name,
      request.params.arguments ?? {},
    );
    return {
      content: [{ type: "text", text: result.content }],
      isError: result.isError,
    };
  });
  return server;
};

const buildEnv = (auth: InferenceAuth, anthropicBaseUrl: string | undefined) =>
  providerCliEnv({
    CLAUDE_CONFIG_DIR: auth.configDir,
    HOME: auth.configDir,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "sealant-control-plane",
    ...(auth.kind === "oauth-token" ? { CLAUDE_CODE_OAUTH_TOKEN: auth.oauthToken } : {}),
    ...(anthropicBaseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: anthropicBaseUrl }),
  });

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const authSettings = (auth: InferenceAuth) =>
  auth.kind === "api-key" ? { settings: { apiKeyHelper: `cat ${shellQuote(auth.keyPath)}` } } : {};

/**
 * The CLI also sets `authentication_failed` from words alone (any error whose message mentions
 * `x-api-key`), so without a 401 status it counts only as auth words.
 */
const turnFailure = (
  status: number | null | undefined,
  assistantError: SDKAssistantMessageError | undefined,
  detail: string,
  secrets: readonly string[],
): InferenceEngineError => {
  if (status === 401) {
    return new InferenceEngineError("auth-401", "Inference failed: the provider answered 401.");
  }
  if (assistantError === "authentication_failed") {
    return new InferenceEngineError("auth-words", "Inference failed: authentication_failed");
  }
  return assistantError === undefined
    ? toEngineError(new Error(detail), secrets)
    : new InferenceEngineError("engine", `Inference failed: ${assistantError}`);
};

const toEngineError = (error: unknown, secrets: readonly string[]): InferenceEngineError => {
  if (error instanceof InferenceEngineError) {
    return error;
  }
  if (error instanceof SessionTurnTimeoutError) {
    return new InferenceEngineError("timeout", error.message);
  }
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactSecrets(raw, secrets);
  return soundsLikeAuthFailure(message)
    ? new InferenceEngineError("auth-words", message, { cause: error })
    : new InferenceEngineError("engine", message, { cause: error });
};

interface LiveSession {
  readonly exchange: Exchange;
  readonly state: InferenceSessionState;
  readonly close: () => void;
  readonly exited: () => Promise<void>;
  readonly onSessionEnd: (() => Promise<void>) | undefined;
}

/** Fire-and-forget: the exchange result never waits on, or fails because of, the hook. */
const runSessionEnd = (onSessionEnd: (() => Promise<void>) | undefined): void => {
  void onSessionEnd?.().catch((error: unknown) => {
    console.warn("Inference onSessionEnd hook failed", { error });
  });
};

export interface ClaudeEngineOptions {
  readonly query?: typeof query;
  /** Tests only: the fake Anthropic API the CLI is sent to. */
  readonly anthropicBaseUrl?: string;
  readonly turnTimeoutMs?: number;
  readonly sessionIdleTtlMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeClaudeEngine = (options: ClaudeEngineOptions = {}): InferenceEngineService => {
  const runQuery = options.query ?? query;
  const turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  const sessionIdleTtlMs = options.sessionIdleTtlMs ?? SESSION_IDLE_TTL_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  const sessions = new Map<string, LiveSession>();

  const dropSession = (id: string): void => {
    const session = sessions.get(id);
    if (session !== undefined) {
      sessions.delete(id);
      session.close();
      // The CLI writes its transcript into the config dir while it shuts down (observed on
      // 2.1.201), so a hook that removes the dir waits for the process to exit.
      void session.exited().then(() => runSessionEnd(session.onSessionEnd));
    }
  };

  let sweeper: NodeJS.Timeout | undefined;
  const ensureSweeper = (): void => {
    if (sweeper !== undefined) {
      return;
    }
    sweeper = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (now - session.state.lastActivityAt > sessionIdleTtlMs) {
          session.state.expire("Inference session expired after inactivity.");
          dropSession(id);
        }
      }
    }, sweepIntervalMs);
    sweeper.unref?.();
  };

  const startExchange = async (input: InferenceStartInput): Promise<InferenceEngineTurn> => {
    ensureSweeper();
    const sessionId = `inf_${randomUUID()}`;
    const state = new InferenceSessionState(sessionId);

    const useNativeStructuredOutput =
      input.responseFormat?.type === "json" &&
      typeof input.responseFormat.schema === "object" &&
      input.responseFormat.schema !== null;
    const jsonByInstruction = input.responseFormat?.type === "json" && !useNativeStructuredOutput;

    const system = [
      ...(input.system === undefined ? [] : [input.system]),
      ...(jsonByInstruction
        ? [
            "Respond ONLY with a single valid JSON value — no prose, no markdown fences around anything else.",
          ]
        : []),
    ].join("\n\n");

    let exited: Promise<void> = Promise.resolve();
    const spawnClaudeCodeProcess = (spawnOptions: SpawnOptions) => {
      const child = spawn(spawnOptions.command, spawnOptions.args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        signal: spawnOptions.signal,
        stdio: ["pipe", "pipe", "ignore"],
      });
      exited = new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
      return child;
    };

    let exchange: ReturnType<typeof query>;
    try {
      exchange = runQuery({
        prompt: input.prompt,
        options: {
          spawnClaudeCodeProcess,
          env: buildEnv(input.auth, options.anthropicBaseUrl),
          ...authSettings(input.auth),
          cwd: tmpdir(),
          // Inference, not an agent workspace: no built-in tools, no filesystem settings, no partials.
          tools: [],
          settingSources: [],
          includePartialMessages: false,
          ...(system.length > 0 ? { systemPrompt: system } : {}),
          ...(input.model === undefined ? {} : { model: input.model }),
          maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
          mcpServers: {
            [CALLER_SERVER_NAME]: {
              type: "sdk",
              name: CALLER_SERVER_NAME,
              instance: buildCallerToolServer(state, input.tools),
            },
          },
          // Auto-approve exactly the caller's tools; nothing else exists to approve.
          allowedTools: input.tools.map((tool) => `mcp__${CALLER_SERVER_NAME}__${tool.name}`),
          ...(useNativeStructuredOutput
            ? {
                outputFormat: {
                  type: "json_schema" as const,
                  schema: input.responseFormat?.schema as Record<string, unknown>,
                },
              }
            : {}),
        },
      });
    } catch (error) {
      runSessionEnd(input.onSessionEnd);
      throw toEngineError(error, input.exchange.secrets);
    }

    sessions.set(sessionId, {
      exchange: input.exchange,
      state,
      close: () => exchange.close(),
      exited: () => exited,
      onSessionEnd: input.onSessionEnd,
    });

    // Drive the exchange in the background; the session state is the rendezvous point.
    void (async () => {
      try {
        let assistantError: SDKAssistantMessageError | undefined;
        for await (const message of exchange) {
          // The CLI retries a 401 and reruns a key's helper, which reads the same file, so a key's
          // first 401 settles the exchange instead of waiting out the backoff. A setup token is
          // judged by the final answer: the CLI's retry can still succeed on it.
          if (
            input.auth.kind === "api-key" &&
            message.type === "system" &&
            message.subtype === "api_retry" &&
            message.error_status === 401
          ) {
            state.fail(turnFailure(401, assistantError, "", input.exchange.secrets));
          }
          if (message.type === "assistant" && message.error !== undefined) {
            assistantError = message.error;
          }
          if (message.type !== "result") {
            continue;
          }
          if (message.subtype === "success" && !message.is_error) {
            const json = useNativeStructuredOutput
              ? message.structured_output
              : jsonByInstruction
                ? extractJson(message.result)
                : undefined;
            state.finish({
              text: message.result,
              ...(json === undefined ? {} : { json }),
              usage: {
                inputTokens: message.usage.input_tokens,
                outputTokens: message.usage.output_tokens,
              },
            });
          } else if (message.subtype === "success") {
            state.fail(
              turnFailure(
                message.api_error_status,
                assistantError,
                message.result,
                input.exchange.secrets,
              ),
            );
          } else {
            const detail = message.errors.length > 0 ? message.errors.join("; ") : message.subtype;
            state.fail(turnFailure(undefined, assistantError, detail, input.exchange.secrets));
          }
        }
        if (!state.isSettled) {
          state.fail(
            new InferenceEngineError("engine", "Inference ended without producing a result."),
          );
        }
      } catch (error) {
        state.fail(toEngineError(error, input.exchange.secrets));
      }
    })();

    return awaitTurn(sessionId, state, input.exchange.secrets);
  };

  const awaitTurn = async (
    sessionId: string,
    state: InferenceSessionState,
    secrets: readonly string[],
  ): Promise<InferenceEngineTurn> => {
    try {
      const turn = await state.nextTurn(turnTimeoutMs);
      if (turn.type === "done") {
        dropSession(sessionId);
      }
      return { sessionId, turn };
    } catch (error) {
      state.expire("Inference exchange failed.");
      dropSession(sessionId);
      throw toEngineError(error, secrets);
    }
  };

  const continueExchange = async (input: InferenceContinueInput): Promise<InferenceEngineTurn> => {
    const session = sessions.get(input.sessionId);
    if (session === undefined) {
      throw new InferenceEngineError(
        "session-not-found",
        `Inference session not found (or expired): ${input.sessionId}. Start the exchange over.`,
      );
    }
    const refused = session.state.resolveToolResults(
      input.toolResults.map((result) => ({
        toolCallId: result.toolCallId,
        result: { content: result.content, isError: result.isError === true },
      })),
    );
    if (refused.length > 0) {
      throw new InferenceEngineError(
        "bad-tool-result",
        `Unknown, repeated or already-settled toolCallId: ${refused.join(", ")}. No result was delivered.`,
      );
    }
    return awaitTurn(input.sessionId, session.state, session.exchange.secrets);
  };

  return {
    exchange: (sessionId) => sessions.get(sessionId)?.exchange,
    start: (input) =>
      Effect.tryPromise({
        try: () => startExchange(input),
        catch: (error) => toEngineError(error, input.exchange.secrets),
      }),
    continueSession: (input) =>
      Effect.tryPromise({
        try: () => continueExchange(input),
        catch: (error) => toEngineError(error, []),
      }),
  };
};

export const claudeEngineLayer = (options?: ClaudeEngineOptions): Layer.Layer<InferenceEngine> =>
  Layer.succeed(InferenceEngine, makeClaudeEngine(options));

export const InferenceEngineLive: Layer.Layer<InferenceEngine> = claudeEngineLayer();
