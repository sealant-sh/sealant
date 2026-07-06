import type { RunLossReport, RunTimelineEntry } from "@sealant/validators";
import { describe, expect, it } from "vitest";

import { foldRunRecord } from "./fold";

let seq = 0;
const entry = (
  kind: string,
  ref: Record<string, unknown>,
  options: { processId?: string; captureMethod?: number; confidence?: number } = {},
): RunTimelineEntry => {
  seq += 1;
  return {
    eventId: `e${seq}`,
    sequence: String(seq),
    kind,
    occurredAt: String(seq * 1_000_000),
    summary: kind,
    ref,
    ...(options.processId === undefined ? {} : { processId: options.processId }),
    captureMethod: options.captureMethod ?? 2,
    confidence: options.confidence ?? 1,
  };
};

const emptyLoss = (overrides: Partial<RunLossReport> = {}): RunLossReport => ({
  runId: "run_test",
  droppedEventCount: "0",
  sequenceGapCount: 0,
  watchOverflowCount: 0,
  earlyClose: false,
  spans: [],
  ...overrides,
});

// Mirrors the real recorded shape: runtime comes up, the harness runs (touching files and the
// network), a test command fails then passes, and a trailing keepalive exit has no recorded start.
const buildTimeline = (): RunTimelineEntry[] => {
  seq = 0;
  return [
    entry("runtimeStateChanged", { state: 2 }, { captureMethod: 8 }),
    entry(
      "processStarted",
      {
        pid: 41,
        executable: "pnpm",
        args: ["install", "--frozen-lockfile"],
        cwd: "/workspace/repo",
      },
      { processId: "p1" },
    ),
    entry("ioChunk", { stream: 2, byteCount: "2048", streamOffset: "0" }, { processId: "p1" }),
    entry(
      "processExited",
      { exitCode: 0, reason: 1, durationMicros: "14600000" },
      { processId: "p1" },
    ),
    entry(
      "processStarted",
      {
        pid: 57,
        executable: "opencode",
        args: ["run", "Fix the empty-cart crash"],
        cwd: "/workspace/repo",
      },
      { processId: "p2" },
    ),
    entry(
      "fileChange",
      { kind: 2, path: "src/checkout.ts", certain: true },
      { processId: "p2", captureMethod: 4 },
    ),
    // No processId on this one — containment must attribute it to the open opencode command.
    entry(
      "fileChange",
      { kind: 1, path: "src/checkout.test.ts", certain: true },
      { captureMethod: 4 },
    ),
    entry(
      "networkRequest",
      {
        scheme: 2,
        method: "POST",
        host: "api.anthropic.com",
        port: 443,
        bytesSent: "1000",
        bytesReceived: "52000",
        durationMicros: "800000",
      },
      { processId: "p2", captureMethod: 3 },
    ),
    entry(
      "networkRequest",
      {
        scheme: 2,
        method: "POST",
        host: "api.anthropic.com",
        port: 443,
        bytesSent: "1200",
        bytesReceived: "48000",
        durationMicros: "650000",
      },
      { processId: "p2", captureMethod: 3 },
    ),
    entry("ioChunk", { stream: 3, byteCount: "300", streamOffset: "0" }, { processId: "p2" }),
    entry(
      "processExited",
      { exitCode: 0, reason: 1, durationMicros: "167000000" },
      { processId: "p2" },
    ),
    entry(
      "processStarted",
      {
        pid: 88,
        executable: "pnpm",
        args: ["test", "--filter", "checkout"],
        cwd: "/workspace/repo",
      },
      { processId: "p3" },
    ),
    entry(
      "processExited",
      { exitCode: 1, reason: 1, durationMicros: "18200000" },
      { processId: "p3" },
    ),
    entry("runtimeHeartbeat", { state: 2 }, { captureMethod: 8 }),
    // Keepalive killed at daemon shutdown — an exit with no recorded start.
    entry("processExited", { signal: 15, reason: 2, durationMicros: "251000000" }),
    entry("runtimeStateChanged", { state: 6, reason: "shutdown" }, { captureMethod: 8 }),
  ];
};

describe("foldRunRecord", () => {
  it("folds processStarted/exited pairs into commands with exit facts", () => {
    const model = foldRunRecord({ entries: buildTimeline() });

    expect(model.commands).toHaveLength(3);
    const [install, agent, test] = model.commands;
    expect(install?.commandLine).toBe("pnpm install --frozen-lockfile");
    expect(install?.exit?.exitCode).toBe(0);
    expect(install?.exit?.reason).toBe("exited");
    expect(install?.running).toBe(false);
    expect(agent?.commandLine).toBe('opencode run "Fix the empty-cart crash"');
    expect(test?.exit?.exitCode).toBe(1);
  });

  it("attributes file activity by processId and by containment fallback", () => {
    const model = foldRunRecord({ entries: buildTimeline() });

    const agent = model.commands[1];
    expect(agent?.files.map((file) => file.path)).toEqual([
      "src/checkout.ts",
      "src/checkout.test.ts",
    ]);
    expect(agent?.files[0]?.kind).toBe("modified");
    expect(agent?.files[1]?.kind).toBe("added");
    // Attributed activity never doubles as a top-level marker.
    const fileMarkers = model.items.filter(
      (item) => item.type === "marker" && item.kind === "fileChange",
    );
    expect(fileMarkers).toHaveLength(0);
  });

  it("aggregates network activity per host instead of one row per request", () => {
    const model = foldRunRecord({ entries: buildTimeline() });

    const agent = model.commands[1];
    expect(agent?.network).toHaveLength(1);
    const net = agent?.network[0];
    expect(net?.host).toBe("api.anthropic.com");
    expect(net?.requestCount).toBe(2);
    expect(net?.bytesReceived).toBe(100_000n);
    expect(net?.scheme).toBe("https");
    expect(model.stats.networkRequestCount).toBe(2);
    expect(model.stats.hostCount).toBe(1);
  });

  it("accrues io byte counts to the owning command by stream", () => {
    const model = foldRunRecord({ entries: buildTimeline() });

    expect(model.commands[0]?.stdoutBytes).toBe(2048n);
    expect(model.commands[1]?.stderrBytes).toBe(300n);
  });

  it("renders an orphan processExited as a marker, not a command", () => {
    const model = foldRunRecord({ entries: buildTimeline() });

    const orphans = model.items.filter(
      (item) => item.type === "marker" && item.kind === "processExited",
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.type === "marker" && orphans[0].label).toContain("start not recorded");
  });

  it("keeps runtime state changes as markers and drops heartbeats", () => {
    const model = foldRunRecord({ entries: buildTimeline() });

    const markers = model.items.filter(
      (item) => item.type === "marker" && item.kind === "runtimeStateChanged",
    );
    expect(markers).toHaveLength(2);
    const heartbeats = model.items.filter(
      (item) => item.type === "marker" && item.kind === "runtimeHeartbeat",
    );
    expect(heartbeats).toHaveLength(0);
  });

  it("interleaves loss spans into the record at their sequence position", () => {
    const entries = buildTimeline();
    const loss = emptyLoss({
      droppedEventCount: "12",
      spans: [
        {
          kind: "dropped_event",
          fromSequence: "6",
          toSequence: "7",
          droppedCount: "12",
          detectedVia: "marker",
          reason: "watch overflow",
        },
        { kind: "early_close", detectedVia: "gap" },
      ],
    });
    const model = foldRunRecord({ entries, loss });

    const gapIndex = model.items.findIndex((item) => item.type === "gap");
    expect(gapIndex).toBeGreaterThan(0);
    const before = model.items[gapIndex - 1];
    // The positioned gap sits before the item whose sequence first exceeds fromSequence=6.
    expect(before?.type).toBe("command");
    const last = model.items[model.items.length - 1];
    expect(last?.type === "gap" && last.kind).toBe("early_close");
  });

  it("keeps unattributed network activity instead of dropping it", () => {
    seq = 0;
    const entries = [
      entry("networkRequest", {
        scheme: 1,
        host: "registry.npmjs.org",
        port: 443,
        bytesSent: "10",
        bytesReceived: "20",
      }),
    ];
    const model = foldRunRecord({ entries });

    expect(model.commands).toHaveLength(0);
    expect(model.unattributedNetwork).toHaveLength(1);
    expect(model.unattributedNetwork[0]?.host).toBe("registry.npmjs.org");
  });

  it("marks a command with no exit as running and computes bounds", () => {
    seq = 0;
    const entries = [
      entry("processStarted", { executable: "pnpm", args: ["dev"] }, { processId: "p1" }),
      entry("ioChunk", { stream: 2, byteCount: "64", streamOffset: "0" }, { processId: "p1" }),
    ];
    const model = foldRunRecord({ entries });

    expect(model.commands[0]?.running).toBe(true);
    expect(model.bounds?.firstOccurredAt).toBe(1_000_000n);
    expect(model.bounds?.lastOccurredAt).toBe(2_000_000n);
  });

  it("returns an empty model for an empty timeline", () => {
    const model = foldRunRecord({ entries: [] });

    expect(model.items).toHaveLength(0);
    expect(model.stats.eventCount).toBe(0);
    expect(model.bounds).toBeUndefined();
  });
});
