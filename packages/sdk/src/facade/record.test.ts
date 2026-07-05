import type { TimelineEntry as WireTimelineEntry } from "@sealant/api-contracts";
import { describe, expect, it } from "vitest";

import { reconstructCommands, renderTranscript } from "./record.js";

let seq = 0;
const entry = (kind: string, ref: Record<string, unknown>): WireTimelineEntry => ({
  eventId: `e${(seq += 1)}`,
  sequence: String(seq),
  kind,
  occurredAt: String(seq),
  summary: kind,
  ref,
});

// Mirrors the real recorded shape: opencode runs, emits output, exits; then two git commands; then a
// trailing signal-15 exit (the boot keepalive killed by daemon shutdown) that has no processStarted.
const TIMELINE: readonly WireTimelineEntry[] = [
  entry("processStarted", {
    executable: "opencode",
    args: ["run", "Append a line."],
    cwd: "/sandbox/repo",
  }),
  entry("ioChunk", { stream: 3, byteCount: "300" }),
  entry("ioChunk", { stream: 2, byteCount: "6" }),
  entry("processExited", { exitCode: 0, durationMicros: "9580094" }),
  entry("processStarted", {
    executable: "sh",
    args: ["-lc", "git diff --cached"],
    cwd: "/sandbox/repo",
  }),
  entry("ioChunk", { stream: 2, byteCount: "134" }),
  entry("processExited", { exitCode: 0, durationMicros: "8921" }),
  entry("runtimeStateChanged", { state: 5, reason: "shutdown requested" }),
  entry("processExited", { signal: 15, durationMicros: "10506601" }),
];

describe("reconstructCommands", () => {
  const commands = reconstructCommands(TIMELINE);

  it("reconstructs the real commands and skips daemon noise", () => {
    expect(commands).toHaveLength(2); // the orphan signal-exit + runtimeStateChanged are skipped
    expect(commands[0]?.executable).toBe("opencode");
    expect(commands[0]?.args).toEqual(["run", "Append a line."]);
    expect(commands[0]?.command).toBe('opencode run "Append a line."'); // arg with spaces is quoted
    expect(commands[0]?.cwd).toBe("/sandbox/repo");
    expect(commands[0]?.exitCode).toBe(0);
    expect(commands[0]?.durationMs).toBe(9580); // micros -> ms
    expect(commands[0]?.stdoutBytes).toBe(6);
    expect(commands[0]?.stderrBytes).toBe(300);
  });

  it("renders a human transcript with no event-kind noise", () => {
    const transcript = renderTranscript(commands);
    expect(transcript).toContain('$ opencode run "Append a line."');
    expect(transcript).toContain("completed (exit 0)");
    expect(transcript).toContain("9.58 s");
    expect(transcript).toContain("$ sh -lc");
    expect(transcript).not.toContain("ioChunk");
    expect(transcript).not.toContain("processStarted");
  });

  it("handles an empty record", () => {
    expect(reconstructCommands([])).toEqual([]);
    expect(renderTranscript([])).toContain("no commands recorded");
  });
});
