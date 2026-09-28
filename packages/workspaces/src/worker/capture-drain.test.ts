/**
 * The drain primitive every platform-initiated stop runs first. The properties that matter: a
 * stop proceeds only when the daemon confirms its FINAL flush `complete`, or a daemon silent for
 * the window on an executor the runtime reports ended; an empty queue without that confirmation
 * is kept; a silent daemon on a running executor is kept; a queue still moving defers; a daemon
 * that answers without moving is kept; progress and the stall window carry across calls AND
 * across workers; one worker at a time drains a run, and a dead worker's claim is taken over.
 */
import { Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";

import type { SealantTarget } from "../sealantd/runtime.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { captureStatusFromStored } from "./capture-drain-ledger.js";
import {
  InMemoryCaptureDrainStore,
  blueprintSourceKind,
  captureDaemonAnswers,
  captureProgressed,
  describeCaptureStatus,
  drainCaptureBeforeStop,
  drainPermitsStop,
  inMemoryCaptureDrainLedger,
  isCaptureSourcedBlueprint,
  recordedDeletionEvidence,
  runIsCaptureSourced,
  snapFailureDetail,
  DEFAULT_FINAL_FLUSH_GRACE_MS,
  finalFlushRequest,
  type CaptureDrainLedger,
  type CaptureDrainSettings,
} from "./capture-drain.js";

const TARGET: SealantTarget = {
  kind: "unix-socket",
  socketPath: "/run/sealant/control.sock",
};

const FAST: CaptureDrainSettings = {
  pollIntervalMs: 1,
  stallWindowMs: 40,
  unreachableWindowMs: 40,
  requestTimeoutMs: 1_000,
};

const drain = (
  daemon: ReturnType<typeof fakeCaptureDaemon>,
  ledger: CaptureDrainLedger,
  budgetMs = 1_000,
  settings: CaptureDrainSettings = FAST,
  runtimeState: "running" | "exited" | "missing" = "running",
) =>
  Effect.runPromise(
    drainCaptureBeforeStop({
      runId: "run_1",
      target: TARGET,
      ledger,
      settings,
      budgetMs,
      label: "test",
      runtimeState: Effect.succeed(runtimeState),
    }).pipe(Effect.provide(daemon.layer)),
  );

describe("drainCaptureBeforeStop", () => {
  it("sends a FINAL flush, then polls status until the daemon confirms the flush complete", async () => {
    const daemon = fakeCaptureDaemon([
      captureStatus({ pending: 3, uploadedBytes: 10 }),
      captureStatus({ pending: 2, uploadedBytes: 20 }),
      savedStatus({ uploadedBytes: 30, registered: 3 }),
    ]);

    const outcome = await drain(daemon, inMemoryCaptureDrainLedger());

    expect(outcome).toMatchObject({
      kind: "drained",
      status: { pending: 0, complete: true },
    });
    expect(drainPermitsStop(outcome)).toBe(true);
    expect(daemon.calls).toEqual(["flush", "status", "status"]);
    // The deadline is the 1 s round trip less a tenth; the 30 s grace is capped at it.
    expect(daemon.flushRequests).toEqual([{ kind: "final", deadlineMs: 900, graceMs: 900 }]);
  });

  it("sends the configured deadline and grace with the FINAL flush", async () => {
    const daemon = fakeCaptureDaemon([savedStatus()]);
    await drain(daemon, inMemoryCaptureDrainLedger(), 1_000, {
      ...FAST,
      finalFlushDeadlineMs: 600,
      finalFlushGraceMs: 250,
    });
    expect(daemon.flushRequests).toEqual([{ kind: "final", deadlineMs: 600, graceMs: 250 }]);
  });

  it("returns drained at once when the final flush reports complete", async () => {
    const daemon = fakeCaptureDaemon([savedStatus()]);
    const outcome = await drain(daemon, inMemoryCaptureDrainLedger());
    expect(outcome.kind).toBe("drained");
    expect(daemon.calls).toEqual(["flush"]);
  });

  it("keeps an empty queue whose daemon does not report completion (sealantd 0.18.2)", async () => {
    // Every daemon up to the pinned 0.18.2: no `complete` field. Its empty queue can hide bulk
    // it never snapshotted, so it is not taken as saved: one more FINAL flush, then kept.
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 0, registered: 4 })]);
    const ledger = inMemoryCaptureDrainLedger();

    const outcome = await drain(daemon, ledger);

    expect(outcome).toMatchObject({
      kind: "unconfirmed",
      status: { pending: 0 },
    });
    expect(drainPermitsStop(outcome)).toBe(false);
    expect(daemon.calls).toEqual(["flush", "flush"]);
    expect(daemon.flushRequests.every((request) => request?.kind === "final")).toBe(true);
    expect(ledger.store.rows.get("run_1")?.observation).toMatchObject({
      state: "kept",
      detail: expect.stringMatching(/^not saved · not confirmed/),
    });
  });

  it("keeps an empty queue whose final flush the daemon reports incomplete", async () => {
    const outcome = await drain(
      fakeCaptureDaemon([captureStatus({ pending: 0, complete: false })]),
      inMemoryCaptureDrainLedger(),
    );
    expect(outcome).toMatchObject({
      kind: "unconfirmed",
      detail: "the daemon reports its final flush incomplete",
    });
    expect(drainPermitsStop(outcome)).toBe(false);
  });

  it("keeps a daemon whose snaps are failing, says so once, and names the error in the keep", async () => {
    // The Docker end to end: a path past PATH_MAX stopped every snap of the session while the
    // queue read pending 0. The status carries the error; the drain must not hide it.
    const failing = captureStatus({
      pending: 0,
      registered: 4,
      complete: false,
      incompleteReason: "snapshot-failed",
      snaps: [
        {
          class: "small",
          snapsFailed: 12,
          lastSnapError: "File name too long (os error 36)",
          snapFailingSinceUnixMs: Date.UTC(2026, 8, 27, 12),
        },
        { class: "bulk", snapsFailed: 0 },
      ],
    });
    const errors: string[] = [];
    const recorder = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Error") {
        errors.push(Array.isArray(message) ? message.join(" ") : String(message));
      }
    });
    const daemon = fakeCaptureDaemon([failing]);
    const ledger = inMemoryCaptureDrainLedger();

    const outcome = await Effect.runPromise(
      drainCaptureBeforeStop({
        runId: "run_1",
        target: TARGET,
        ledger,
        settings: FAST,
        budgetMs: 1_000,
        label: "test",
        runtimeState: Effect.succeed("running"),
      }).pipe(Effect.provide(daemon.layer), Effect.provide(Logger.layer([recorder]))),
    );

    const snapFailure =
      "small snaps failing since 2026-09-27T12:00:00.000Z (12 failed): File name too long (os error 36)";
    expect(outcome).toMatchObject({
      kind: "unconfirmed",
      detail: `the daemon reports its final flush incomplete (snapshot-failed) · ${snapFailure}`,
    });
    expect(drainPermitsStop(outcome)).toBe(false);
    // Two FINAL flushes saw the same error: logged once as not captured, once as the keep.
    expect(
      errors.filter((line) => line.includes("not captured · small snaps failing")),
    ).toHaveLength(1);
    expect(errors.filter((line) => line.includes("not saved · not confirmed · kept"))).toHaveLength(
      1,
    );
    expect(ledger.store.rows.get("run_1")?.observation?.detail).toContain(snapFailure);
  });

  it("flushes again when the queue empties after an incomplete flush, and then saves", async () => {
    const daemon = fakeCaptureDaemon([
      captureStatus({ pending: 2, complete: false }),
      captureStatus({ pending: 0, complete: false, registered: 2 }),
      savedStatus({ registered: 3 }),
    ]);
    const outcome = await drain(daemon, inMemoryCaptureDrainLedger());
    expect(outcome.kind).toBe("drained");
    expect(daemon.calls).toEqual(["flush", "status", "flush"]);
  });

  it("asks for another FINAL while the daemon is sealing, and saves once the seal is acknowledged", async () => {
    // sealantd reports `incomplete_reason: "sealing"` after a deadline-cut FINAL: nothing is
    // pending, but the chain's seal is not acknowledged yet. Empty but unconfirmed: FINAL again.
    const sealing = captureStatus({ pending: 0, complete: false, incompleteReason: "sealing" });
    const daemon = fakeCaptureDaemon([sealing, savedStatus()]);
    const outcome = await drain(daemon, inMemoryCaptureDrainLedger());
    expect(outcome.kind).toBe("drained");
    expect(daemon.calls).toEqual(["flush", "flush"]);
    expect(daemon.flushRequests.every((request) => request?.kind === "final")).toBe(true);
  });

  it("never takes a sealing daemon as saved: kept, and the next sweep flushes again", async () => {
    const sealing = captureStatus({ pending: 0, complete: false, incompleteReason: "sealing" });
    const daemon = fakeCaptureDaemon([sealing]);
    const outcome = await drain(daemon, inMemoryCaptureDrainLedger());
    expect(outcome).toMatchObject({
      kind: "unconfirmed",
      detail: expect.stringContaining("final flush incomplete (sealing)"),
    });
    expect(drainPermitsStop(outcome)).toBe(false);
    expect(daemon.calls).toEqual(["flush", "flush"]);
  });

  it("asks for FINAL again when the disk changed after a complete final flush (sealantd `changed`)", async () => {
    // Complete means current: a change after the final flush's snap makes sealantd answer
    // `complete: false, incomplete_reason: "changed"`. Not saved: FINAL again, which snaps again.
    const changed = captureStatus({ pending: 0, complete: false, incompleteReason: "changed" });
    const daemon = fakeCaptureDaemon([changed, savedStatus()]);
    const outcome = await drain(daemon, inMemoryCaptureDrainLedger());
    expect(outcome.kind).toBe("drained");
    expect(daemon.calls).toEqual(["flush", "flush"]);
    expect(daemon.flushRequests.every((request) => request?.kind === "final")).toBe(true);
  });

  it("no longer counts a complete flush the disk changed after as evidence", async () => {
    // An earlier drain read `complete`; the disk changed since, and the next read says so. The
    // ledger's evidence follows the newest read: the executor may not go on the old one.
    const ledger = inMemoryCaptureDrainLedger();
    expect((await drain(fakeCaptureDaemon([savedStatus()]), ledger)).kind).toBe("drained");
    const executor = { runId: "run_1", resourceId: "container-1", reference: null };
    expect(recordedDeletionEvidence(Effect.runSync(ledger.read("run_1")), executor)).toMatchObject({
      observedComplete: true,
    });
    const changed = captureStatus({ pending: 0, complete: false, incompleteReason: "changed" });
    const outcome = await drain(fakeCaptureDaemon([changed]), ledger);
    expect(outcome).toMatchObject({
      kind: "unconfirmed",
      detail: expect.stringContaining("final flush incomplete (changed)"),
    });
    expect(drainPermitsStop(outcome)).toBe(false);
    expect(recordedDeletionEvidence(Effect.runSync(ledger.read("run_1")), executor)).toMatchObject({
      observedComplete: false,
    });
  });

  it("keeps a workspace whose daemon answers but whose queue does not move", async () => {
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 4, uploadedBytes: 100 })]);

    const outcome = await drain(daemon, inMemoryCaptureDrainLedger());

    expect(outcome).toMatchObject({ kind: "stalled", status: { pending: 4 } });
    expect(drainPermitsStop(outcome)).toBe(false);
  });

  it("keeps a workspace whose registrar refused a capture class, even with a complete flush", async () => {
    const outcome = await drain(
      fakeCaptureDaemon([savedStatus({ refused: ["bulk"] })]),
      inMemoryCaptureDrainLedger(),
    );
    expect(outcome).toMatchObject({ kind: "stalled", detail: "refused bulk" });
    expect(drainPermitsStop(outcome)).toBe(false);
  });

  it("keeps a workspace whose daemon refuses the capture commands", async () => {
    const outcome = await drain(fakeCaptureDaemon(["refused"]), inMemoryCaptureDrainLedger());
    expect(outcome).toMatchObject({
      kind: "stalled",
      detail: expect.stringMatching(/capture/),
    });
    expect(drainPermitsStop(outcome)).toBe(false);
  });

  it("defers while the queue is still moving and the budget is spent, carrying progress over", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    let uploaded = 0;
    const moving = Array.from({ length: 200 }, () => {
      uploaded += 100;
      return captureStatus({ pending: 5, uploadedBytes: uploaded });
    });
    const first = await drain(fakeCaptureDaemon(moving), ledger, 5);

    expect(first.kind).toBe("pending");
    expect(drainPermitsStop(first)).toBe(false);
    expect(ledger.store.rows.get("run_1")?.observation?.state).toBe("draining");

    // The next call (the reaper's next tick) finds it saved and lets the stop through.
    const second = await drain(fakeCaptureDaemon([savedStatus()]), ledger);
    expect(second.kind).toBe("drained");
    expect(ledger.store.rows.get("run_1")?.observation?.state).toBe("saved");
  });

  it("measures the stall window from the last progress, across calls", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    const stuck = captureStatus({ pending: 2, uploadedBytes: 50 });
    // First call: one answer, budget too short to see a stall.
    expect((await drain(fakeCaptureDaemon([stuck]), ledger, 1)).kind).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Nothing moved since: the very first answer of the next call is already past the window.
    const daemon = fakeCaptureDaemon([stuck]);
    expect((await drain(daemon, ledger, 1)).kind).toBe("stalled");
    expect(daemon.calls).toEqual(["flush"]);
  });

  it("keeps a workspace whose daemon is silent while the runtime reports it running", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    const outcome = await drain(fakeCaptureDaemon(["unreachable"]), ledger);
    expect(outcome.kind).toBe("silent");
    expect(drainPermitsStop(outcome)).toBe(false);

    // The next sweep asks again and, still silent past the window, answers at once.
    const daemon = fakeCaptureDaemon(["unreachable"]);
    expect((await drain(daemon, ledger, 1_000)).kind).toBe("silent");
    expect(daemon.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps an executor that ended before any drain reached its daemon (its disk remains)", async () => {
    // Review 2 #2: sealantd exits 75 with its staging on disk after its own shutdown FINAL
    // fails, whether or not a drain of ours ever reached it.
    const outcome = await drain(
      fakeCaptureDaemon(["unreachable"]),
      inMemoryCaptureDrainLedger(),
      1_000,
      FAST,
      "exited",
    );
    expect(outcome.kind).toBe("silent");
    expect(drainPermitsStop(outcome)).toBe(false);
  });

  it("lets the stop through when the daemon never answered and nothing of the executor is left", async () => {
    const outcome = await drain(
      fakeCaptureDaemon(["unreachable"]),
      inMemoryCaptureDrainLedger(),
      1_000,
      FAST,
      "missing",
    );
    expect(outcome.kind).toBe("gone");
    expect(drainPermitsStop(outcome)).toBe(true);
  });

  it("keeps an executor that exited after answering a final flush it never confirmed complete", async () => {
    // sealantd exits (75) after an incomplete final flush and keeps its staging on the disk. The
    // container / Pod that ended still has that disk: removing it would destroy the only copy.
    const ledger = inMemoryCaptureDrainLedger();
    const first = await drain(
      fakeCaptureDaemon([
        captureStatus({
          pending: 2,
          complete: false,
          incompleteReason: "ship-failed",
        }),
      ]),
      ledger,
      1,
    );
    expect(first.kind).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const exited = await drain(fakeCaptureDaemon(["unreachable"]), ledger, 1_000, FAST, "exited");
    expect(exited).toMatchObject({
      kind: "silent",
      detail: expect.stringMatching(/without a final flush confirmed complete/),
    });
    expect(drainPermitsStop(exited)).toBe(false);

    // Once the runtime reports nothing of it left, there is nothing to keep.
    const missing = await drain(fakeCaptureDaemon(["unreachable"]), ledger, 1_000, FAST, "missing");
    expect(missing.kind).toBe("gone");
  });

  it("does not treat a short silence as a crash", async () => {
    const outcome = await drain(
      fakeCaptureDaemon(["unreachable", "unreachable", savedStatus()]),
      inMemoryCaptureDrainLedger(),
      1_000,
      { ...FAST, unreachableWindowMs: 10_000 },
    );
    expect(outcome.kind).toBe("drained");
  });

  // e2e 5: the lifecycle stop's drain saw the final flush complete and went on to remove the
  // runtime; the stranded reaper then drained the same run and retried the silent daemon 12
  // times over 55 s after the container was gone (the silent window is 5 minutes).
  const SLOW_SILENCE: CaptureDrainSettings = {
    ...FAST,
    pollIntervalMs: 5,
    unreachableWindowMs: 60_000,
  };

  it("ends at once, saved, when the executor ended after its daemon reported the final flush complete", async () => {
    const store = new InMemoryCaptureDrainStore();
    const first = await drain(
      fakeCaptureDaemon([savedStatus()]),
      inMemoryCaptureDrainLedger({ store }),
    );
    expect(first.kind).toBe("drained");

    for (const ended of ["missing", "exited"] as const) {
      const daemon = fakeCaptureDaemon(["unreachable"]);
      const outcome = await drain(
        daemon,
        inMemoryCaptureDrainLedger({ store }),
        200,
        SLOW_SILENCE,
        ended,
      );
      expect(outcome).toMatchObject({ kind: "drained", status: { complete: true } });
      expect(daemon.connect).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps an executor that ended at the first silence, without waiting out the window", async () => {
    const daemon = fakeCaptureDaemon(["unreachable"]);
    const outcome = await drain(daemon, inMemoryCaptureDrainLedger(), 200, SLOW_SILENCE, "exited");
    expect(outcome).toMatchObject({
      kind: "silent",
      detail: expect.stringMatching(/without a final flush confirmed complete/),
    });
    expect(daemon.connect).toHaveBeenCalledTimes(1);
  });

  it("works under a claim the caller holds and leaves it held", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    const claim = await Effect.runPromise(ledger.claim("run_1"));
    expect(claim).toBeDefined();
    const outcome = await Effect.runPromise(
      drainCaptureBeforeStop({
        runId: "run_1",
        target: TARGET,
        ledger,
        settings: FAST,
        budgetMs: 1_000,
        label: "test",
        runtimeState: Effect.succeed("running"),
        ...(claim === undefined ? {} : { claim }),
      }).pipe(Effect.provide(fakeCaptureDaemon([savedStatus()]).layer)),
    );
    expect(outcome.kind).toBe("drained");
    // Still the caller's: another drain of the run is refused until the caller releases it.
    expect(
      await drain(
        fakeCaptureDaemon([savedStatus()]),
        inMemoryCaptureDrainLedger({ store: ledger.store }),
      ),
    ).toEqual({ kind: "busy" });
  });
});

describe("drain ownership across workers", () => {
  it("refuses a second worker's drain of a run while the first worker drains it", async () => {
    // Two workers = two ledgers over one store (one database). While worker A's drain is in
    // flight, worker B's sweep of the same run must not drain (or stop) it too.
    const store = new InMemoryCaptureDrainStore();
    const workerA = inMemoryCaptureDrainLedger({ store, owner: "worker-a" });
    const workerB = inMemoryCaptureDrainLedger({ store, owner: "worker-b" });
    let uploaded = 0;
    const moving = Array.from({ length: 50 }, () => {
      uploaded += 10;
      return captureStatus({ pending: 3, uploadedBytes: uploaded });
    });
    const daemonA = fakeCaptureDaemon([...moving, savedStatus()]);
    const daemonB = fakeCaptureDaemon([savedStatus()]);

    const inFlight = drain(daemonA, workerA, 5_000, {
      ...FAST,
      pollIntervalMs: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await drain(daemonB, workerB);

    expect(second.kind).toBe("busy");
    expect(daemonB.connect).not.toHaveBeenCalled();
    expect((await inFlight).kind).toBe("drained");
    // Released: the next sweep of either worker may claim it.
    expect((await drain(fakeCaptureDaemon([savedStatus()]), workerB)).kind).toBe("drained");
  });

  it("carries the stall window to the worker that picks the run up next", async () => {
    const store = new InMemoryCaptureDrainStore();
    const stuck = captureStatus({ pending: 2, uploadedBytes: 50 });
    expect(
      (await drain(fakeCaptureDaemon([stuck]), inMemoryCaptureDrainLedger({ store }), 1)).kind,
    ).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Another worker: nothing moved since the first worker's answer, so it is already stalled.
    const outcome = await drain(
      fakeCaptureDaemon([stuck]),
      inMemoryCaptureDrainLedger({ store }),
      1,
    );
    expect(outcome.kind).toBe("stalled");
  });

  it("takes over a run whose worker died holding it, once the lease expires", async () => {
    let now = 1_000;
    const store = new InMemoryCaptureDrainStore();
    const dead = inMemoryCaptureDrainLedger({
      store,
      owner: "dead",
      leaseMs: 100,
      now: () => now,
    });
    const live = inMemoryCaptureDrainLedger({
      store,
      owner: "live",
      leaseMs: 100,
      now: () => now,
    });

    // The dead worker claimed and never released.
    expect(await Effect.runPromise(dead.claim("run_1"))).toBeDefined();
    expect((await drain(fakeCaptureDaemon([savedStatus()]), live)).kind).toBe("busy");

    now += 101;
    expect((await drain(fakeCaptureDaemon([savedStatus()]), live)).kind).toBe("drained");
  });

  it("gives the drain up when its claim was taken over mid-drain", async () => {
    let now = 1_000;
    const store = new InMemoryCaptureDrainStore();
    const slow = inMemoryCaptureDrainLedger({
      store,
      owner: "slow",
      leaseMs: 100,
      now: () => now,
    });
    const other = inMemoryCaptureDrainLedger({
      store,
      owner: "other",
      leaseMs: 100,
      now: () => now,
    });
    const daemon = fakeCaptureDaemon([captureStatus({ pending: 1, uploadedBytes: 1 })]);
    // The slow worker's claim lapses before its first answer lands; another worker claims.
    const connect = daemon.connect;
    daemon.connect.mockImplementationOnce((...args: Parameters<typeof connect>) => {
      now += 101;
      void Effect.runSync(other.claim("run_1"));
      return connect.getMockImplementation()?.(...args) ?? Effect.die("no implementation");
    });

    const outcome = await drain(daemon, slow);

    expect(outcome.kind).toBe("busy");
    expect(store.rows.get("run_1")?.owner).toMatch(/^other#/);
  });
});

describe("drain ownership within one worker", () => {
  it("admits one of two simultaneous claims on a run from the same worker process", async () => {
    // Review 2 RISK: every stop path of a worker shares one lease owner, and the claim admitted
    // an existing lease of the same owner, so two concurrent drains of one run both ran.
    const ledger = inMemoryCaptureDrainLedger({ owner: "one-worker" });
    const claims = await Effect.runPromise(
      Effect.all([ledger.claim("run"), ledger.claim("run")], { concurrency: "unbounded" }),
    );
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
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

const decide = (
  sourceKind: string | null,
  snapshot: { readonly blueprintPayload: unknown } | undefined,
) =>
  Effect.runPromise(
    runIsCaptureSourced({
      runId: "run_1",
      sourceKind,
      readSnapshotPayload: Effect.succeed(snapshot),
    }),
  );

describe("runIsCaptureSourced", () => {
  it("trusts the source kind recorded on the runtime instance", async () => {
    expect(await decide("capture", undefined)).toBe(true);
    expect(await decide("github", undefined)).toBe(false);
  });

  it("falls back to the attempt snapshot on a row that predates the column", async () => {
    expect(
      await decide(null, {
        blueprintPayload: { sources: { workspace: { kind: "capture" } } },
      }),
    ).toBe(true);
    expect(
      await decide(null, {
        blueprintPayload: { sources: { workspace: { kind: "github" } } },
      }),
    ).toBe(false);
  });

  it("fails closed: no recorded kind and no readable snapshot is capture-sourced", async () => {
    expect(await decide(null, undefined)).toBe(true);
    expect(await decide(null, { blueprintPayload: {} })).toBe(true);
  });
});

describe("helpers", () => {
  it("recognises a capture source in a stored blueprint of any vintage", () => {
    expect(
      isCaptureSourcedBlueprint({
        sources: { workspace: { kind: "capture" } },
      }),
    ).toBe(true);
    expect(isCaptureSourcedBlueprint({ sources: { workspace: { kind: "github" } } })).toBe(false);
    expect(blueprintSourceKind({})).toBeUndefined();
    expect(blueprintSourceKind(null)).toBeUndefined();
  });

  it("counts fewer pending, more uploaded/registered, or a completed flush as progress", () => {
    const base = captureStatus({
      pending: 3,
      uploadedBytes: 10,
      registered: 1,
    });
    expect(captureProgressed(undefined, base)).toBe(true);
    expect(captureProgressed(base, { ...base, pending: 2 })).toBe(true);
    expect(captureProgressed(base, { ...base, uploadedBytes: 11 })).toBe(true);
    expect(captureProgressed(base, { ...base, registered: 2 })).toBe(true);
    expect(captureProgressed(base, { ...base, complete: true })).toBe(true);
    expect(captureProgressed(base, { ...base, pending: 4 })).toBe(false);
    expect(captureProgressed(base, base)).toBe(false);
  });
});

describe("finalFlushRequest", () => {
  const settings = (overrides: Partial<CaptureDrainSettings> = {}): CaptureDrainSettings => ({
    ...FAST,
    requestTimeoutMs: 60_000,
    ...overrides,
  });

  it("asks for FINAL with the round trip's bound less 5 s and a 30 s grace by default", () => {
    expect(finalFlushRequest(settings())).toEqual({
      kind: "final",
      deadlineMs: 55_000,
      graceMs: DEFAULT_FINAL_FLUSH_GRACE_MS,
    });
    expect(DEFAULT_FINAL_FLUSH_GRACE_MS).toBe(30_000);
  });

  it("takes a lower configured deadline and grace as they are", () => {
    expect(
      finalFlushRequest(settings({ finalFlushDeadlineMs: 20_000, finalFlushGraceMs: 5_000 })),
    ).toEqual({ kind: "final", deadlineMs: 20_000, graceMs: 5_000 });
  });

  it("never lets the deadline reach the round trip's bound, nor the grace pass the deadline", () => {
    expect(
      finalFlushRequest(settings({ finalFlushDeadlineMs: 120_000, finalFlushGraceMs: 90_000 })),
    ).toEqual({ kind: "final", deadlineMs: 55_000, graceMs: 55_000 });
    expect(finalFlushRequest(settings({ requestTimeoutMs: 20_000 }))).toEqual({
      kind: "final",
      deadlineMs: 18_000,
      graceMs: 18_000,
    });
  });
});

describe("capture status past the pinned wire", () => {
  const everything = captureStatus({
    pending: 2,
    pendingBulk: 1,
    pendingBytes: 2048,
    bulkBuilding: true,
    complete: false,
    incompleteReason: "unreadable",
    unreadable: 5,
    carried: 4,
    unreadablePaths: [`tree/${"a".repeat(5000)}`, "tree/b", ".git/c", "harness/d"],
    registerRefused: "missing-objects",
    registerRefusedN: 9,
    registerMissing: ["obj/ab12", "obj/cd34"],
    registerRefusals: 2,
    repairing: true,
    snaps: [
      {
        class: "small",
        snapsFailed: 3,
        lastSnapError: "File name too long (os error 36)",
      },
      {
        class: "bulk",
        snapsFailed: 1,
        lastSnapError: "Permission denied",
        snapFailingSinceUnixMs: 0,
      },
    ],
    lastSnapError: "Permission denied",
    snapFailingSinceUnixMs: 0,
    snapsFailed: 4,
  });

  it("describes every field a newer daemon reports, clipping what it cannot bound", () => {
    const line = describeCaptureStatus(everything);
    for (const part of [
      "pending 2",
      "1 bulk pending",
      "bulk building",
      "2048 bytes to ship",
      "final flush incomplete (unreadable)",
      "small snaps failing (3 failed): File name too long (os error 36)",
      "bulk snaps failing since 1970-01-01T00:00:00.000Z (1 failed): Permission denied",
      "unreadable 5 (4 carried forward): tree/aaaa",
      "tree/b, .git/c, …",
      "register refused missing-objects at n 9 (2 missing keys listed)",
      "repairing",
      "2 register refusals",
    ]) {
      expect(line).toContain(part);
    }
    // A path past PATH_MAX is clipped: one log line never carries it whole.
    expect(line.length).toBeLessThan(1_000);
  });

  it("describes a pinned-wire status without any of them", () => {
    const line = describeCaptureStatus(captureStatus({ pending: 1 }));
    expect(line).toBe(
      "pending 1 · staged 0 bytes · uploaded 0 bytes · registered 0 · completion not reported",
    );
    expect(snapFailureDetail(captureStatus())).toBeUndefined();
  });

  it("keeps every field through the ledger's stored status", () => {
    const stored: unknown = JSON.parse(JSON.stringify(everything));
    expect(captureStatusFromStored(stored)).toEqual(everything);
    const pinned = captureStatus({ pending: 1 });
    expect(captureStatusFromStored(JSON.parse(JSON.stringify(pinned)))).toEqual(pinned);
  });
});
