/**
 * Lowers the public inference options onto the control-plane's `/v1/inference/respond` payload and
 * maps the wire response back onto the public types. Pure and side-effect free — unit-testable on
 * its own; the client calls these around `inferenceRespondOp`.
 *
 * SECURITY: only account **references** cross here (`true` → the literal account name `"default"`);
 * token material never appears on either side of this mapping.
 */
import type { InferenceRespondRequest, InferenceRespondResponse } from "@sealant/api-contracts";

import type {
  InferenceContinueOptions,
  InferenceRespondOptions,
  InferenceResponse,
  InferenceTurn,
} from "../types.js";

const DEFAULT_ACCOUNT_NAME = "default";

const mapAccountRef = (value: boolean | string | undefined): string | undefined => {
  if (value === undefined || value === false) {
    return undefined;
  }
  return value === true ? DEFAULT_ACCOUNT_NAME : value;
};

export const buildInferenceRespondRequest = (
  options: InferenceRespondOptions | InferenceContinueOptions,
  ownerUserId: string,
): InferenceRespondRequest => {
  if ("sessionId" in options) {
    return {
      ownerUserId,
      sessionId: options.sessionId,
      toolResults: options.toolResults.map((result) => ({
        toolCallId: result.toolCallId,
        content: result.content,
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      })),
    };
  }

  const claude = mapAccountRef(options.credentials.claude);
  const codex = mapAccountRef(options.credentials.codex);
  return {
    ownerUserId,
    credentials: {
      ...(options.credentials.profile === undefined
        ? {}
        : { profileId: options.credentials.profile }),
      ...(claude === undefined ? {} : { claude }),
      ...(codex === undefined ? {} : { codex }),
    },
    prompt: options.prompt,
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.tools === undefined
      ? {}
      : {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.inputSchema,
          })),
        }),
    ...(options.responseFormat === undefined
      ? {}
      : {
          responseFormat: {
            type: options.responseFormat.type,
            ...(options.responseFormat.schema === undefined
              ? {}
              : { schema: options.responseFormat.schema }),
          },
        }),
  };
};

export const mapInferenceResponse = (wire: InferenceRespondResponse): InferenceResponse => {
  const turn: InferenceTurn =
    wire.turn.type === "text"
      ? {
          type: "text",
          text: wire.turn.text,
          ...(wire.turn.json === undefined ? {} : { json: wire.turn.json }),
        }
      : {
          type: "toolCalls",
          calls: wire.turn.calls.map((call) => ({
            toolCallId: call.toolCallId,
            name: call.name,
            input: call.input,
          })),
        };
  return {
    sessionId: wire.sessionId,
    turn,
    ...(wire.usage === undefined
      ? {}
      : { usage: { inputTokens: wire.usage.inputTokens, outputTokens: wire.usage.outputTokens } }),
  };
};
