/**
 * Unit tests for the run-exec message codec — the two framings (`command` = harness, `commands` =
 * exec/check run) must round-trip and malformed messages must be rejected before they reach the
 * worker (a bad message dead-letters instead of poisoning the consumer).
 */
import { describe, expect, it } from "vitest";

import { parseRunExecRequestedMessage, runExecRequestedMessageKind } from "./run-exec-queue.js";

const base = { kind: runExecRequestedMessageKind, runId: "run_1" };

describe("parseRunExecRequestedMessage", () => {
  it("parses the harness framing (single command)", () => {
    const parsed = parseRunExecRequestedMessage({
      ...base,
      command: { executable: "opencode", args: ["run", "fix it"], cwd: "/workspace/repo" },
    });
    expect(parsed).toEqual({
      ...base,
      command: { executable: "opencode", args: ["run", "fix it"], cwd: "/workspace/repo" },
    });
    expect(parsed.commands).toBeUndefined();
  });

  it("parses the exec framing (ordered command list) and preserves order", () => {
    const parsed = parseRunExecRequestedMessage({
      ...base,
      commands: [
        { executable: "git", args: ["checkout", "base"] },
        { executable: "pnpm", args: ["test"], cwd: "/workspace/repo/pkg" },
      ],
    });
    expect(parsed.command).toBeUndefined();
    expect(parsed.commands).toEqual([
      { executable: "git", args: ["checkout", "base"] },
      { executable: "pnpm", args: ["test"], cwd: "/workspace/repo/pkg" },
    ]);
  });

  it("rejects a message with neither framing", () => {
    expect(() => parseRunExecRequestedMessage(base)).toThrow(/missing\/invalid command/);
  });

  it("rejects an empty commands list", () => {
    expect(() => parseRunExecRequestedMessage({ ...base, commands: [] })).toThrow(
      /non-empty array/,
    );
  });

  it("rejects a malformed entry inside the commands list, naming its index", () => {
    expect(() =>
      parseRunExecRequestedMessage({
        ...base,
        commands: [
          { executable: "git", args: ["status"] },
          { executable: "", args: [] },
        ],
      }),
    ).toThrow(/commands\[1\]/);
  });

  it("rejects a wrong kind or missing runId", () => {
    expect(() =>
      parseRunExecRequestedMessage({ kind: "other", runId: "run_1", command: {} }),
    ).toThrow(/unexpected kind/);
    expect(() =>
      parseRunExecRequestedMessage({
        kind: runExecRequestedMessageKind,
        command: { executable: "x", args: [] },
      }),
    ).toThrow(/missing runId/);
  });
});
