/**
 * Unit tests for the inference option/response mapping: account references lower exactly like
 * workspace credentials (`true` → "default"), the two option shapes discriminate on `sessionId`,
 * and only references — never secret-shaped fields — appear in the built payload.
 */
import { describe, expect, it } from "vitest";

import { buildInferenceRespondRequest, mapInferenceResponse } from "./inference.js";

describe("buildInferenceRespondRequest", () => {
  it("builds a new-exchange payload with lowered account references", () => {
    const payload = buildInferenceRespondRequest(
      {
        prompt: "Summarize the run.",
        system: "You are terse.",
        tools: [{ name: "get_run", inputSchema: { type: "object" } }],
        responseFormat: { type: "json", schema: { type: "object" } },
        credentials: { claude: true, profile: "prof_1" },
      },
      "usr_local",
    );

    expect(payload).toEqual({
      ownerUserId: "usr_local",
      credentials: { profileId: "prof_1", claude: "default" },
      prompt: "Summarize the run.",
      system: "You are terse.",
      tools: [{ name: "get_run", inputSchema: { type: "object" } }],
      responseFormat: { type: "json", schema: { type: "object" } },
    });
  });

  it("builds a continuation payload from sessionId + toolResults", () => {
    const payload = buildInferenceRespondRequest(
      {
        sessionId: "inf_1",
        toolResults: [{ toolCallId: "tc_1", content: "ok" }],
      },
      "usr_local",
    );
    expect(payload).toEqual({
      ownerUserId: "usr_local",
      sessionId: "inf_1",
      toolResults: [{ toolCallId: "tc_1", content: "ok" }],
    });
  });

  it("passes a named account through unchanged", () => {
    const payload = buildInferenceRespondRequest(
      { prompt: "p", credentials: { claude: "work-account" } },
      "usr_local",
    );
    expect(payload.credentials).toEqual({ claude: "work-account" });
  });
});

describe("mapInferenceResponse", () => {
  it("maps a text turn with parsed json and usage", () => {
    expect(
      mapInferenceResponse({
        sessionId: "inf_1",
        turn: { type: "text", text: '{"ok":true}', json: { ok: true } },
        usage: { inputTokens: 10, outputTokens: 3 },
      }),
    ).toEqual({
      sessionId: "inf_1",
      turn: { type: "text", text: '{"ok":true}', json: { ok: true } },
      usage: { inputTokens: 10, outputTokens: 3 },
    });
  });

  it("maps a toolCalls turn", () => {
    expect(
      mapInferenceResponse({
        sessionId: "inf_1",
        turn: {
          type: "toolCalls",
          calls: [{ toolCallId: "tc_1", name: "get_run", input: { id: "run_1" } }],
        },
      }),
    ).toEqual({
      sessionId: "inf_1",
      turn: {
        type: "toolCalls",
        calls: [{ toolCallId: "tc_1", name: "get_run", input: { id: "run_1" } }],
      },
    });
  });
});
