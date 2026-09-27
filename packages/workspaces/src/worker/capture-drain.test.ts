/**
 * The drain primitive every platform-initiated stop runs first. The properties that matter: a
 * stop proceeds only on an empty queue or a daemon that has been silent for the unreachable
 * window; a queue still moving defers; a daemon that answers without moving is kept; progress and
 * the stall window carry across calls; overlapping drains of one run are refused.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { SealantTarget } from "../sealantd/runtime.js";
import { captureStatus, fakeCaptureDaemon } from "./capture-daemon.fixture.js";
import {
  CaptureDrainTracker,
  captureDaemonAnswers,
  captureProgressed,
  drainCaptureBeforeStop,
  drainPermitsStop,
  isCaptureSourcedBlueprint,
  type CaptureDrainSettings,
} from "./capture-drain.js";

const TARGET: SealantTarget = { kind: "unix-socket", socketPath: "/run/sealant/control.sock" };

const FAST: CaptureDrainSettings = {
  pollIntervalMs: 1,
  stallWindowMs: 40,
  unreachableWindowMs: 40,
  requestTimeoutMs: 1_000,
};

const drain = (
  daemon: ReturnType<typeof fakeCaptureDaemon>,
  tracker: CaptureDrainTracker,
  budgetMs = 1_000,
  settings: CaptureDrainSettings = FAST,
) =>
  Effect.runPromise(
    drainCaptureBeforeStop({
      runId: "run_1",
      target: TARGET,
      tracker,
      settings,
      budgetMs,
      label: "test",
    }).pipe(Effect.provide(daemon.layer)),
  );

describe("drainCaptureBeforeStop", () => {
  it("flushes once, then polls status until the queue is empty", async () => {
    const daemon = fakeCaptureDaemon([
      captureStatus({ pending: 3, uploadedBytes: 10 }),
      captureStatus({ pending: 2, uploadedBytes: 20 }),
      captureStatus({ pending: 0, uploadedBytes: 30, registered: 3 }),
    ]);

    const outcome = await drain(daemon, new CaptureDrainTracker());

    expect(outcome).toMatchObject({ kind: "drained", status: { pending: 0 } });
    expect(drainPermitsStop(outcome)).toBe(true);
    expect(daemon.calls).toEqual(["flush", "status", "status"]);
  });

  it("returns drained at once when the queue is already empty", async () => {
    const daemon = fakeCaptureDaemon([captureStatus()]);
    const outcome = await drain(daemon, new CaptureDrainTracker());
    expect(outcome.kind).toBe("drained");
    expect(daemon.calls).toEqual(["flush"]);
  });

  it("keeps a workspace whose daemon answers but whose queue does not move", async () => {
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 4, uploadedBytes: 100 })]);

    const outcome = await drain(daemon, new CaptureDrainTracker());

    expect(outcome).toMatchObject({ kind: "stalled", status: { pending: 4 } });
    expect(drainPermitsStop(outcome)).toBe(false);
  });

  it("keeps a workspace whose daemon refuses the capture commands", async () => {
    const outcome = await drain(fakeCaptureDaemon(["refused"]), new CaptureDrainTracker());
    expect(outcome).toMatchObject({ kind: "stalled", detail: expect.stringMatching(/capture/) });
    expect(drainPermitsStop(outcome)).toBe(false);
  });

  it("defers while the queue is still moving and the budget is spent, carrying progress over", async () => {
    const tracker = new CaptureDrainTracker();
    let uploaded = 0;
    const moving = Array.from({ length: 200 }, () => {
      uploaded += 100;
      return captureStatus({ pending: 5, uploadedBytes: uploaded });
    });
    const first = await drain(fakeCaptureDaemon(moving), tracker, 5);

    expect(first.kind).toBe("pending");
    expect(drainPermitsStop(first)).toBe(false);
    expect(tracker.runIds()).toEqual(["run_1"]);

    // The next call (the reaper's next tick) finds it empty and lets the stop through.
    const second = await drain(fakeCaptureDaemon([captureStatus({ pending: 0 })]), tracker);
    expect(second.kind).toBe("drained");
  });

  it("measures the stall window from the last progress, across calls", async () => {
    const tracker = new CaptureDrainTracker();
    const stuck = captureStatus({ pending: 2, uploadedBytes: 50 });
    // First call: one answer, budget too short to see a stall.
    expect((await drain(fakeCaptureDaemon([stuck]), tracker, 1)).kind).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Nothing moved since: the very first answer of the next call is already past the window.
    const daemon = fakeCaptureDaemon([stuck]);
    expect((await drain(daemon, tracker, 1)).kind).toBe("stalled");
    expect(daemon.calls).toEqual(["flush"]);
  });

  it("lets the stop through once the daemon stays silent for the unreachable window", async () => {
    const outcome = await drain(fakeCaptureDaemon(["unreachable"]), new CaptureDrainTracker());
    expect(outcome.kind).toBe("unreachable");
    expect(drainPermitsStop(outcome)).toBe(true);
  });

  it("does not treat a short silence as a crash", async () => {
    const outcome = await drain(
      fakeCaptureDaemon(["unreachable", "unreachable", captureStatus({ pending: 0 })]),
      new CaptureDrainTracker(),
      1_000,
      { ...FAST, unreachableWindowMs: 10_000 },
    );
    expect(outcome.kind).toBe("drained");
  });

  it("refuses a second drain of the same run while one is in flight", async () => {
    const tracker = new CaptureDrainTracker();
    expect(tracker.tryBegin("run_1")).toBe(true);
    const outcome = await drain(fakeCaptureDaemon([captureStatus()]), tracker);
    expect(outcome.kind).toBe("busy");
    tracker.end("run_1");
    expect((await drain(fakeCaptureDaemon([captureStatus()]), tracker)).kind).toBe("drained");
  });
});

describe("captureDaemonAnswers", () => {
  it("counts a refusal as an answer and a failed connection as none", async () => {
    const ask = (answer: "refused" | "unreachable") =>
      Effect.runPromise(
        captureDaemonAnswers(TARGET, 1_000).pipe(Effect.provide(fakeCaptureDaemon([answer]).layer)),
      );
    expect(await ask("refused")).toBe(true);
    expect(await ask("unreachable")).toBe(false);
  });
});

describe("helpers", () => {
  it("recognises a capture source in a stored blueprint of any vintage", () => {
    expect(isCaptureSourcedBlueprint({ sources: { workspace: { kind: "capture" } } })).toBe(true);
    expect(isCaptureSourcedBlueprint({ sources: { workspace: { kind: "github" } } })).toBe(false);
    expect(isCaptureSourcedBlueprint({})).toBe(false);
    expect(isCaptureSourcedBlueprint(null)).toBe(false);
  });

  it("counts fewer pending or more uploaded/registered as progress, a new snapshot as none", () => {
    const base = captureStatus({ pending: 3, uploadedBytes: 10, registered: 1 });
    expect(captureProgressed(undefined, base)).toBe(true);
    expect(captureProgressed(base, { ...base, pending: 2 })).toBe(true);
    expect(captureProgressed(base, { ...base, uploadedBytes: 11 })).toBe(true);
    expect(captureProgressed(base, { ...base, registered: 2 })).toBe(true);
    expect(captureProgressed(base, { ...base, pending: 4 })).toBe(false);
    expect(captureProgressed(base, base)).toBe(false);
  });
});
