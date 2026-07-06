/**
 * The Claude inference engine — runs the exchange through the OFFICIAL Claude Agent SDK.
 *
 * COMPLIANCE (docs/connected-accounts-design.md §2/§9, load-bearing): the stored subscription token
 * is consumed exactly the way Anthropic documents for third parties — `CLAUDE_CODE_OAUTH_TOKEN` in
 * the environment of the official Claude Code runtime, which the Agent SDK spawns and drives. This
 * module NEVER calls a model API directly, never logs the token, and strips any ambient
 * `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the subprocess env so the exchange cannot
 * silently bill a different identity than the resolved connected account.
 *
 * Caller-defined tools are exposed to the model through an in-process MCP server registered with
 * the caller's JSON schemas VERBATIM (the low-level @modelcontextprotocol/sdk server — the agent
 * SDK's `tool()` helper would force a Zod re-modeling). Tool handlers PARK on the session state
 * until the caller posts results over HTTP — that is the caller-executed multi-turn tool loop.
 * Built-in Claude Code tools are disabled wholesale (`tools: []`): this endpoint is inference, not
 * an agent workspace, and nothing may touch the control plane's filesystem or network on the
 * model's behalf.
 *
 * Sessions live in a module-level map (deliberately NOT layer state: they must survive across
 * requests regardless of how the request-dependency layer is scoped) and expire after a few idle
 * minutes.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Context, Effect, Layer } from "effect";

import {
  InferenceSessionState,
  SessionTurnTimeoutError,
  type SessionTurn,
  type ToolResultInput,
} from "./session-state.js";
import { extractJson, isAuthFailureMessage, redactSecret } from "./support.js";

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

export interface InferenceStartInput {
  /** Decrypted connected-account OAuth token. Used ONLY for the subprocess env; never stored. */
  readonly oauthToken: string;
  readonly prompt: string;
  readonly system?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly tools: readonly InferenceToolDefinition[];
  readonly responseFormat?: { readonly type: "json"; readonly schema?: unknown };
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
  readonly reason: "auth" | "session-not-found" | "bad-tool-result" | "timeout" | "engine";
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

interface LiveSession {
  readonly state: InferenceSessionState;
  readonly close: () => void;
}

// Module-level on purpose — see the header comment.
const sessions = new Map<string, LiveSession>();

let sweeper: NodeJS.Timeout | undefined;
const ensureSweeper = (): void => {
  if (sweeper !== undefined) {
    return;
  }
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.state.lastActivityAt > SESSION_IDLE_TTL_MS) {
        session.state.expire("Inference session expired after inactivity.");
        session.close();
        sessions.delete(id);
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
};

const dropSession = (id: string): void => {
  const session = sessions.get(id);
  if (session !== undefined) {
    session.close();
    sessions.delete(id);
  }
};

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

/** Subprocess env: ambient Anthropic identities stripped, the resolved account's token injected. */
const buildEnv = (oauthToken: string): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];
  delete env["ANTHROPIC_PROFILE"];
  env["CLAUDE_CODE_OAUTH_TOKEN"] = oauthToken;
  env["CLAUDE_AGENT_SDK_CLIENT_APP"] = "sealant-control-plane";
  return env;
};

const toEngineError = (error: unknown, oauthToken: string): InferenceEngineError => {
  if (error instanceof InferenceEngineError) {
    return error;
  }
  if (error instanceof SessionTurnTimeoutError) {
    return new InferenceEngineError("timeout", error.message);
  }
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactSecret(raw, oauthToken);
  return isAuthFailureMessage(message)
    ? new InferenceEngineError("auth", message, { cause: error })
    : new InferenceEngineError("engine", message, { cause: error });
};

const startExchange = async (input: InferenceStartInput): Promise<InferenceEngineTurn> => {
  ensureSweeper();
  const sessionId = `inf_${randomUUID()}`;
  const state = new InferenceSessionState(sessionId);
  const mcpServer = buildCallerToolServer(state, input.tools);

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

  const exchange = query({
    prompt: input.prompt,
    options: {
      env: buildEnv(input.oauthToken),
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
          instance: mcpServer,
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

  sessions.set(sessionId, { state, close: () => exchange.close() });

  // Drive the exchange in the background; the session state is the rendezvous point.
  void (async () => {
    try {
      for await (const message of exchange) {
        if (message.type === "assistant" && message.error !== undefined) {
          state.fail(
            new InferenceEngineError(
              message.error === "authentication_failed" ? "auth" : "engine",
              `Inference failed: ${message.error}`,
            ),
          );
        }
        if (message.type !== "result") {
          continue;
        }
        if (message.subtype === "success") {
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
        } else {
          const detail = message.errors.length > 0 ? message.errors.join("; ") : message.subtype;
          state.fail(toEngineError(new Error(detail), input.oauthToken));
        }
      }
      if (!state.isSettled) {
        state.fail(
          new InferenceEngineError("engine", "Inference ended without producing a result."),
        );
      }
    } catch (error) {
      state.fail(toEngineError(error, input.oauthToken));
    }
  })();

  try {
    const turn = await state.nextTurn(TURN_TIMEOUT_MS);
    if (turn.type === "done") {
      dropSession(sessionId);
    }
    return { sessionId, turn };
  } catch (error) {
    state.expire("Inference exchange failed.");
    dropSession(sessionId);
    throw toEngineError(error, input.oauthToken);
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
  for (const result of input.toolResults) {
    const resolved = session.state.resolveToolResult(result.toolCallId, {
      content: result.content,
      isError: result.isError === true,
    });
    if (!resolved) {
      throw new InferenceEngineError(
        "bad-tool-result",
        `Unknown or already-settled toolCallId: ${result.toolCallId}.`,
      );
    }
  }
  try {
    const turn = await session.state.nextTurn(TURN_TIMEOUT_MS);
    if (turn.type === "done") {
      dropSession(input.sessionId);
    }
    return { sessionId: input.sessionId, turn };
  } catch (error) {
    session.state.expire("Inference exchange failed.");
    dropSession(input.sessionId);
    throw toEngineError(error, "");
  }
};

export const InferenceEngineLive = Layer.succeed(InferenceEngine, {
  start: (input) =>
    Effect.tryPromise({
      try: () => startExchange(input),
      catch: (error) => toEngineError(error, input.oauthToken),
    }),
  continueSession: (input) =>
    Effect.tryPromise({
      try: () => continueExchange(input),
      catch: (error) => toEngineError(error, ""),
    }),
});
