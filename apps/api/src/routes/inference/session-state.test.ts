/**
 * Unit tests for the inference-session mechanics: parked tool calls batch into turns after the
 * quiet window (parallel calls travel together), caller results resolve the parked handlers, the
 * final answer wins, and expiry rejects everything. Short quiet windows keep the tests real-time.
 */
import { describe, expect, it } from "vitest";

import { InferenceSessionState, SessionTurnTimeoutError } from "./session-state.js";

const quiet = { quietMs: 10 };

describe("InferenceSessionState", () => {
  it("batches parallel tool calls into one turn after the quiet window", async () => {
    const state = new InferenceSessionState("inf_1", quiet);
    const handlerA = state.park("search", { q: "a" });
    const handlerB = state.park("search", { q: "b" });

    const turn = await state.nextTurn(1_000);
    expect(turn.type).toBe("toolCalls");
    if (turn.type !== "toolCalls") {
      return;
    }
    expect(turn.calls).toHaveLength(2);
    expect(turn.calls.map((call) => call.name)).toEqual(["search", "search"]);

    // The caller executes both and posts results — the parked handlers resolve with them.
    const [a, b] = turn.calls;
    expect(state.resolveToolResult(a!.toolCallId, { content: "ra", isError: false })).toBe(true);
    expect(state.resolveToolResult(b!.toolCallId, { content: "rb", isError: true })).toBe(true);
    await expect(handlerA).resolves.toEqual({ content: "ra", isError: false });
    await expect(handlerB).resolves.toEqual({ content: "rb", isError: true });
  });

  it("resolves the waiter with the final answer when the exchange completes", async () => {
    const state = new InferenceSessionState("inf_2", quiet);
    const waiting = state.nextTurn(1_000);
    state.finish({ text: "42", usage: { inputTokens: 10, outputTokens: 2 } });

    await expect(waiting).resolves.toEqual({
      type: "done",
      text: "42",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    // A later turn request answers immediately with the same settled result.
    await expect(state.nextTurn(1_000)).resolves.toMatchObject({ type: "done", text: "42" });
  });

  it("hands out calls parked before the turn request arrived", async () => {
    const state = new InferenceSessionState("inf_3", quiet);
    void state.park("lookup", {});
    await new Promise((resolve) => setTimeout(resolve, 30)); // quiet window long past
    const turn = await state.nextTurn(1_000);
    expect(turn.type).toBe("toolCalls");
  });

  it("rejects unknown tool-call ids", () => {
    const state = new InferenceSessionState("inf_4", quiet);
    expect(state.resolveToolResult("tc_nope", { content: "", isError: false })).toBe(false);
  });

  it("times out a turn wait when nothing arrives", async () => {
    const state = new InferenceSessionState("inf_5", quiet);
    await expect(state.nextTurn(20)).rejects.toBeInstanceOf(SessionTurnTimeoutError);
  });

  it("expiry rejects parked handlers and pending waiters", async () => {
    const state = new InferenceSessionState("inf_6", quiet);
    const handler = state.park("search", {});
    const waiting = state.nextTurn(1_000).catch((error: unknown) => error);
    state.expire("test expiry");

    await expect(handler).rejects.toThrow(/test expiry/);
    const waited = await waiting;
    expect(waited).toBeInstanceOf(Error);
  });

  it("refuses concurrent turn waiters", async () => {
    const state = new InferenceSessionState("inf_7", quiet);
    const first = state.nextTurn(200).catch(() => undefined);
    await expect(state.nextTurn(200)).rejects.toThrow(/already has a request waiting/);
    state.finish({ text: "done" });
    await first;
  });
});
