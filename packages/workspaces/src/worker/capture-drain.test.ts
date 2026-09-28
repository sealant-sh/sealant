/**
 * The drain primitive every platform-initiated stop runs first. The properties that matter: a
 * stop proceeds only when the daemon confirms its FINAL flush `complete`, or a daemon silent for
 * the window on an executor the runtime reports ended; an empty queue without that confirmation
 * is kept; a silent daemon on a running executor is kept; a queue still moving defers; a daemon
 * that answers without moving is kept; progress and the stall window carry across calls AND
 * across workers; one worker at a time drains a run, and a dead worker's claim is taken over.
 */
import { Effect, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";

import { removalRefused } from "../runtime/runtime-adapter.js";
import type { CaptureFlushReport, SealantTarget } from "../sealantd/runtime.js";
import { captureStatus, fakeCaptureDaemon, savedStatus } from "./capture-daemon.fixture.js";
import { captureStatusFromStored } from "./capture-drain-ledger.js";
import {
  InMemoryCaptureDrainStore,
  attestedCompleteFor,
  authorizedDeletion,
  blueprintSourceKind,
  ledgerObservationRecorder,
  probeCaptureDaemon,
  captureProgressed,
  describeCaptureStatus,
  drainCaptureBeforeStop,
  drainPermitsStop,
  inMemoryCaptureDrainLedger,
  isCaptureSourcedBlueprint,
  recordedDeletionEvidence,
  removeUnderDeletion,
  reportsComplete,
  runIsCaptureSourced,
  snapFailureDetail,
  DEFAULT_FINAL_FLUSH_GRACE_MS,
  finalFlushRequest,
  type CaptureDrainLedger,
  type CaptureDrainSettings,
  type DeletionTicket,
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

  it("reads the status again when a FINAL's connection closes under it, never taking the close as the outcome (e2e 6)", async () => {
    // e2e 6: the FINAL's sweep killed Core's `docker exec … socat` bridge, so every stop logged
    // `refused: connection closed` and retried a FINAL per poll. The daemon had answered complete.
    const daemon = fakeCaptureDaemon(["closed", savedStatus()]);
    const outcome = await drain(daemon, inMemoryCaptureDrainLedger());
    expect(outcome.kind).toBe("drained");
    expect(daemon.calls).toEqual(["flush", "status"]);

    // Its status says the FINAL never got there (not-final): it is asked again, once.
    const notFinal = captureStatus({ pending: 2, complete: false, incompleteReason: "not-final" });
    const again = fakeCaptureDaemon(["closed", notFinal, savedStatus()]);
    expect((await drain(again, inMemoryCaptureDrainLedger())).kind).toBe("drained");
    expect(again.calls).toEqual(["flush", "status", "flush"]);
  });

  it("waits for a FINAL still at work after its connection closed, without asking again", async () => {
    const working = captureStatus({ pending: 2, complete: false, incompleteReason: "in-progress" });
    const daemon = fakeCaptureDaemon(["closed", working, savedStatus()]);
    const outcome = await drain(daemon, inMemoryCaptureDrainLedger());
    expect(outcome.kind).toBe("drained");
    expect(daemon.calls).toEqual(["flush", "status", "status"]);
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

  it("takes `unwatched`, and any reason a newer daemon adds, as not saved: FINAL again (e2e 5)", async () => {
    // sealantd e2e 5: a class that polls leaves currency unknown in status reads
    // (`unwatched`); only a FINAL asked again answers from its own snaps.
    for (const incompleteReason of ["unwatched", "a-reason-this-core-does-not-know"]) {
      const unknown = captureStatus({ pending: 0, complete: false, incompleteReason });
      const daemon = fakeCaptureDaemon([unknown, savedStatus()]);
      const outcome = await drain(daemon, inMemoryCaptureDrainLedger());
      expect(outcome.kind).toBe("drained");
      expect(daemon.calls).toEqual(["flush", "flush"]);
      expect(daemon.flushRequests.every((request) => request?.kind === "final")).toBe(true);

      const still = fakeCaptureDaemon([unknown]);
      const kept = await drain(still, inMemoryCaptureDrainLedger());
      expect(kept).toMatchObject({
        kind: "unconfirmed",
        detail: expect.stringContaining(incompleteReason),
      });
      expect(drainPermitsStop(kept)).toBe(false);
    }
  });

  it("never takes `store-fidelity` as saved: the store cannot hold what the daemon writes (review 4)", async () => {
    // sealantd round 4: a registrar that cannot read every manifest feature the daemon writes
    // (git_trees) gets no lossy downgrade; the FINAL never completes and says `store-fidelity`.
    const lossy = captureStatus({
      pending: 0,
      complete: false,
      incompleteReason: "store-fidelity",
    });
    const daemon = fakeCaptureDaemon([lossy]);
    const ledger = inMemoryCaptureDrainLedger();
    const kept = await drain(daemon, ledger);
    expect(kept).toMatchObject({
      kind: "unconfirmed",
      detail: expect.stringContaining("store-fidelity"),
    });
    expect(drainPermitsStop(kept)).toBe(false);
    expect(reportsComplete(lossy)).toBe(false);
    // Even beside a `complete: true`, the reason means not saved.
    expect(reportsComplete({ ...lossy, complete: true })).toBe(false);
    expect(
      recordedDeletionEvidence(
        { readable: true, entry: ledger.store.rows.get("run_1")?.entry },
        { runId: "run_1", resourceId: "c1", reference: null },
      ).observedComplete,
    ).toBe(false);
  });

  it("never takes `complete: true` with a reason beside it as saved", async () => {
    const contradictory = captureStatus({
      pending: 0,
      complete: true,
      incompleteReason: "unwatched",
    });
    const daemon = fakeCaptureDaemon([contradictory]);
    const ledger = inMemoryCaptureDrainLedger();
    const outcome = await drain(daemon, ledger);
    expect(outcome.kind).toBe("unconfirmed");
    expect(
      recordedDeletionEvidence(
        { readable: true, entry: ledger.store.rows.get("run_1")?.entry },
        { runId: "run_1", resourceId: "c1", reference: null },
      ).observedComplete,
    ).toBe(false);
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

describe("drainCaptureBeforeStop · a newer observation of the executor (review 5 #3)", () => {
  it("keeps an executor whose newer relayed status says not saved, though the drain read complete", async () => {
    const base = inMemoryCaptureDrainLedger();
    const notSaved = captureStatus({ complete: false, incompleteReason: "snapshot-failed" });
    let injected = false;
    // The public status route relays a newer answer right after the drain recorded its own:
    // recorded against the run, after the drain's reading.
    const ledger: CaptureDrainLedger = {
      ...base,
      recordStatus: (runId, status, atMs, fence) =>
        base.recordStatus(runId, status, atMs, fence).pipe(
          Effect.tap(() =>
            !injected && reportsComplete(status)
              ? Effect.suspend(() => {
                  injected = true;
                  return base.recordStatus(runId, notSaved, atMs);
                })
              : Effect.void,
          ),
        ),
    };
    const daemon = fakeCaptureDaemon([savedStatus()]);

    const outcome = await drain(daemon, ledger);

    expect(outcome).toMatchObject({ kind: "unconfirmed", status: notSaved });
    expect(drainPermitsStop(outcome)).toBe(false);
    // The record keeps the newer reading, and says the executor is kept.
    const row = base.store.rows.get("run_1");
    expect(row?.entry.last).toEqual(notSaved);
    expect(row?.observation?.state).toBe("kept");
  });

  it("never lets a drain's progress write touch the status on record", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    const claimed = await Effect.runPromise(ledger.claim("run_2"));
    const notSaved = captureStatus({ complete: false, incompleteReason: "changed" });
    await Effect.runPromise(ledger.recordStatus("run_2", notSaved, 2_000));
    await Effect.runPromise(
      ledger.save(
        "run_2",
        claimed?.token ?? "",
        {
          lastProgressAt: 3_000,
          unreachableSince: undefined,
          keptLogged: false,
          silentLogged: false,
          last: savedStatus(),
          lastAtMs: 3_000,
        },
        undefined,
      ),
    );
    expect(ledger.store.rows.get("run_2")?.entry.last).toEqual(notSaved);
    expect(ledger.store.rows.get("run_2")?.entry.lastProgressAt).toBe(3_000);
  });
});

// Review 6 #6 helpers: a position in the executor's own history, and statuses stamped with it.
// Unless a test says otherwise every boot reports generation 1: boots that share a generation
// cannot be ordered against each other.
const origin = (observation: number, bootId = "boot-1", bootGeneration = 1) => ({
  epoch: 3,
  launch: "launch-1",
  bootId,
  bootGeneration,
  observation,
  headN: 7,
});
const complete = (observation?: number, bootId?: string) =>
  savedStatus(observation === undefined ? {} : { origin: origin(observation, bootId) });
const failed = (observation?: number, bootId?: string) =>
  captureStatus({
    complete: false,
    incompleteReason: "snapshot-failed",
    ...(observation === undefined ? {} : { origin: origin(observation, bootId) }),
  });
const open = (ledger: ReturnType<typeof inMemoryCaptureDrainLedger>) =>
  Effect.runPromise(ledger.openObservation("run_1", 60_000)).then((fence) => {
    if (fence === undefined) {
      throw new Error("no fence");
    }
    return fence;
  });
const last = (ledger: ReturnType<typeof inMemoryCaptureDrainLedger>) =>
  ledger.store.rows.get("run_1")?.entry.last;

// Review 6 #6: evidence is ordered by the executor's own history, never by a reader's clock.
describe("recordStatus · ordered by the executor, not by clocks (review 6 #6)", () => {
  it("keeps the answer the executor made later, whatever clock read either", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    const a = await open(ledger);
    const b = await open(ledger);
    // A newer failure, read by a worker whose clock is behind; then an older complete, read by a
    // worker whose clock is ahead and recorded second.
    await Effect.runPromise(ledger.recordStatus("run_1", failed(9), 1_000, b));
    await Effect.runPromise(ledger.recordStatus("run_1", complete(8), 9_000, a));
    expect(reportsComplete(last(ledger))).toBe(false);
    // A later complete does replace it.
    const c = await open(ledger);
    await Effect.runPromise(ledger.recordStatus("run_1", complete(10), 500, c));
    expect(reportsComplete(last(ledger))).toBe(true);
  });

  it("orders a recovery boot after the boot before it by its generation", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    const a = await open(ledger);
    const b = await open(ledger);
    // The recovery boot's complete (generation 2) outranks the first boot's failure, however
    // high that boot's observation number went; the reverse never happens.
    await Effect.runPromise(
      ledger.recordStatus("run_1", savedStatus({ origin: origin(1, "boot-2", 2) }), 1_000, a),
    );
    await Effect.runPromise(
      ledger.recordStatus(
        "run_1",
        captureStatus({
          complete: false,
          incompleteReason: "snapshot-failed",
          origin: origin(500, "boot-1", 1),
        }),
        9_000,
        b,
      ),
    );
    expect(reportsComplete(last(ledger))).toBe(true);
  });

  it("orders by causality where no position does, and fails closed where nothing does", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    const a = await open(ledger);
    const b = await open(ledger);
    // Concurrent, unstamped: a complete recorded after a failure does not make it complete.
    await Effect.runPromise(ledger.recordStatus("run_1", failed(), 9_000, a));
    await Effect.runPromise(ledger.recordStatus("run_1", complete(), 1_000, b));
    expect(reportsComplete(last(ledger))).toBe(false);
    // Another boot's position cannot be compared either.
    const c = await open(ledger);
    const d = await open(ledger);
    await Effect.runPromise(ledger.recordStatus("run_1", failed(50, "boot-1"), 1_000, c));
    await Effect.runPromise(ledger.recordStatus("run_1", complete(1, "boot-2"), 2_000, d));
    expect(reportsComplete(last(ledger))).toBe(false);
    // Asked after the failure was recorded: the newer answer, whatever it says.
    const e = await open(ledger);
    await Effect.runPromise(ledger.recordStatus("run_1", complete(), 0, e));
    expect(reportsComplete(last(ledger))).toBe(true);
  });

  // Review 9 #4 (decision 25): one latest status cannot hold two unsaved answers no position
  // orders; an answer that arrives later and covers only one of them must not erase the other.
  it("keeps every unsaved answer no later one covers, and a seal stands only over all of them (review 9 #4)", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    const executor = { runId: "run_1", resourceId: null, reference: null };
    const oldA = await open(ledger);
    const savedA = await open(ledger);
    const failedB = await open(ledger);
    await Effect.runPromise(ledger.recordStatus("run_1", complete(100), 1_000, savedA));
    const row = ledger.store.rows.get("run_1");
    if (row === undefined) {
      throw new Error("no row");
    }
    // The control plane's seal of boot 1's observation 100.
    row.entry = {
      ...row.entry,
      completionAttested: {
        executorId: "run_1",
        epoch: 1,
        captureN: 7,
        origin: origin(100),
        atMs: 1_000,
        by: "control plane",
      },
    };
    // A recovery boot whose generation was not persisted (0) fails: no position orders it.
    await Effect.runPromise(
      ledger.recordStatus(
        "run_1",
        captureStatus({
          complete: false,
          incompleteReason: "snapshot-failed",
          origin: origin(1, "boot-B", 0),
        }),
        2_000,
        failedB,
      ),
    );
    const blocked = await Effect.runPromise(ledger.read("run_1"));
    expect(blocked.readable && attestedCompleteFor(blocked.entry, executor)).toBe(false);
    // Boot 1's pre-seal answer, delayed: the seal covers it, not boot B's failure.
    await Effect.runPromise(ledger.recordStatus("run_1", failed(90), 3_000, oldA));
    const revived = await Effect.runPromise(ledger.read("run_1"));
    expect(revived.readable && attestedCompleteFor(revived.entry, executor)).toBe(false);
    expect(recordedDeletionEvidence(revived, executor)).toMatchObject({
      observedComplete: false,
      attestedComplete: false,
    });
    expect(revived.readable && revived.entry?.unsaved?.map((s) => s.origin?.bootId)).toEqual([
      "boot-B",
      "boot-1",
    ]);
    // An answer asked for after both were recorded covers them: saved again.
    const fresh = await open(ledger);
    await Effect.runPromise(ledger.recordStatus("run_1", complete(101), 4_000, fresh));
    const saved = await Effect.runPromise(ledger.read("run_1"));
    expect(saved.readable && saved.entry?.unsaved).toBeUndefined();
    expect(recordedDeletionEvidence(saved, executor)).toMatchObject({ observedComplete: true });
  });

  it("keeps a drain's complete answer unconfirmed while an unsaved answer it does not cover is on record (review 9 #4)", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    // Both asked before the drain's FINAL was sent, recorded while it runs: boot B's failure (no
    // position orders it) and boot 1's older not-saved answer.
    const failedB = await open(ledger);
    const olderA = await open(ledger);
    let raced = false;
    const racing: CaptureDrainLedger = {
      ...ledger,
      openObservation: (runId, ttlMs) =>
        ledger.openObservation(runId, ttlMs).pipe(
          Effect.tap(() =>
            raced
              ? Effect.void
              : Effect.gen(function* () {
                  raced = true;
                  yield* ledger.recordStatus(
                    "run_1",
                    captureStatus({
                      complete: false,
                      incompleteReason: "snapshot-failed",
                      origin: origin(1, "boot-B", 0),
                    }),
                    2_000,
                    failedB,
                  );
                  yield* ledger.recordStatus("run_1", failed(95), 2_500, olderA);
                }),
          ),
        ),
    };
    // The FINAL's complete answer follows boot 1's (it is the latest status), not boot B's.
    const outcome = await drain(fakeCaptureDaemon([complete(100)]), racing);
    expect(last(ledger)?.complete).toBe(true);
    expect(outcome.kind).toBe("unconfirmed");
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

describe("probeCaptureDaemon", () => {
  it("counts a refusal as an answer, a failed connection as none, and records what it reads", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    const probe = (answer: "refused" | "unreachable" | CaptureFlushReport) =>
      Effect.runPromise(
        probeCaptureDaemon(TARGET, 1_000, ledgerObservationRecorder(ledger, "run_1", 1_000)).pipe(
          Effect.provide(fakeCaptureDaemon([answer]).layer),
        ),
      );
    expect((await probe("refused")).kind).toBe("refused");
    expect((await probe("unreachable")).kind).toBe("unreachable");
    expect(await probe(savedStatus())).toMatchObject({ kind: "status", recorded: true });
    expect(reportsComplete(ledger.store.rows.get("run_1")?.entry.last)).toBe(true);
    // Every observation resolved: nothing is left in flight.
    expect(ledger.store.rows.get("run_1")?.fences?.size).toBe(0);
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

// Review 8 #7: a removal's hold lasts 120 s and is renewed while the runtime call runs; a renewal
// that failed (a database error maps to `false`) ended the renewals without revoking the call.
// Once the hold lapsed, observations and recovery were admitted again — a fresh `complete:false`
// was recorded — and the old runtime call still completed and recorded the executor `deleted`.
// A removal the runtime was asked to make now stays exclusionary until its outcome is recorded
// or settled from the runtime, whatever becomes of its hold.
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);
const versionOf = async (ledger: CaptureDrainLedger, runId: string) => {
  const read = await run(ledger.read(runId));
  return read.readable ? (read.entry?.evidenceVersion ?? 0) : -1;
};
// What a stop of a running executor decides without a drain of its own: keep.
const keepRunning = () => ({
  delete: false as const,
  reason: "a running executor needs a drain",
});

describe("an issued removal outlives its hold (review 8 #7)", () => {
  it("admits no fresh evidence, no recovery and no second deleter while the runtime call runs past its hold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const base = inMemoryCaptureDrainLedger({ now: () => Date.now() });
      await run(base.recordStatus("run_lapse", savedStatus({ headN: 7 }), Date.now()));
      const authorized = await run(
        base.authorizeDeletion("run_lapse", await versionOf(base, "run_lapse")),
      );
      if (authorized.kind !== "authorized") {
        throw new Error(authorized.kind);
      }
      let issued = false;
      // Every renewal once the runtime call is out fails, as the database ledger maps an error.
      const ledger: CaptureDrainLedger = {
        ...base,
        confirmDeletion: (runId, ticket) =>
          Effect.suspend(() =>
            issued ? Effect.succeed(false) : base.confirmDeletion(runId, ticket),
          ),
      };
      let finish!: () => void;
      const provider = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const deleting = Effect.runPromise(
        removeUnderDeletion({
          ledger,
          runId: "run_lapse",
          ticket: authorized.ticket,
          remove: Effect.promise(async () => {
            issued = true;
            await provider;
          }),
        }),
      );
      // Past the 120 s hold, with no renewal landing.
      await vi.advanceTimersByTimeAsync(121_000);
      expect(issued).toBe(true);
      expect(await run(base.openObservation("run_lapse", 1_000))).toBeUndefined();
      expect(await run(base.admitRecovery("run_lapse"))).toBe("deleting");
      expect(
        (await run(base.authorizeDeletion("run_lapse", await versionOf(base, "run_lapse")))).kind,
      ).not.toBe("authorized");
      finish();
      expect(await deleting).toMatchObject({ removed: true });
      const row = base.store.rows.get("run_lapse");
      expect(row?.deletion?.state).toBe("deleted");
      // Nothing newer was admitted in the interval: the evidence it was removed on is the last.
      expect(row?.entry.last?.complete).toBe(true);
      expect(row?.entry.last?.headN).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A removal issued on saved/head 7 whose issuer died: its hold lapsed, no outcome recorded. */
  const lapsedIssue = async () => {
    let clock = 0;
    const ledger = inMemoryCaptureDrainLedger({ now: () => clock });
    await run(ledger.recordStatus("run_issued", savedStatus({ headN: 7 }), clock));
    const authorized = await run(
      ledger.authorizeDeletion("run_issued", await versionOf(ledger, "run_issued")),
    );
    if (authorized.kind !== "authorized") {
      throw new Error(authorized.kind);
    }
    expect(await run(ledger.issueDeletion("run_issued", authorized.ticket))).toBe(true);
    clock += 121_000;
    const state = () => ledger.store.rows.get("run_issued")?.deletion?.state;
    return { ledger, ticket: authorized.ticket, state, advance: (ms: number) => (clock += ms) };
  };

  it("settles it as deleted when the runtime no longer has the executor", async () => {
    const { ledger, state } = await lapsedIssue();
    const settled = await run(
      authorizedDeletion({
        ledger,
        runId: "run_issued",
        runtime: "missing",
        decide: () => ({ delete: true, basis: "missing" }),
      }),
    );
    expect(settled.decision).toEqual({ delete: true, basis: "missing" });
    expect(settled.ticket).toBeUndefined();
    expect(state()).toBe("deleted");
    expect(await run(ledger.admitRecovery("run_issued"))).toBe("deleted");
  });

  it("issues it again when the runtime still has the executor and its evidence still stands", async () => {
    const { ledger, ticket, state } = await lapsedIssue();
    const settled = await run(
      authorizedDeletion({ ledger, runId: "run_issued", runtime: "running", decide: keepRunning }),
    );
    expect(settled.decision).toEqual({ delete: true, basis: "issued-before" });
    const reissue: DeletionTicket | undefined = settled.ticket;
    expect(reissue).toBeDefined();
    expect(reissue?.token).not.toBe(ticket.token);
    // Still issued throughout: nothing is admitted between the settlement and the call.
    expect(state()).toBe("deleting-issued");
    expect(await run(ledger.openObservation("run_issued", 1_000))).toBeUndefined();
    // The old issuer's late failure gives nothing up: the removal is the new ticket's now.
    await run(ledger.releaseDeletion("run_issued", ticket));
    expect(state()).toBe("deleting-issued");
    const removal = await run(
      removeUnderDeletion({
        ledger,
        runId: "run_issued",
        ticket: reissue,
        remove: Effect.succeed("removed"),
      }),
    );
    expect(removal).toEqual({ removed: true, value: "removed" });
    expect(state()).toBe("deleted");
  });

  /** A status recorded anyway (asked without a fence): kept as evidence, voiding nothing issued. */
  const changeEvidence = (ledger: ReturnType<typeof inMemoryCaptureDrainLedger>) =>
    run(
      ledger.recordStatus(
        "run_issued",
        captureStatus({ complete: false, incompleteReason: "snapshot-failed", headN: 8 }),
        0,
      ),
    );

  // Review 9 #5 (decision 27): the runtime still having the executor proves only that the
  // earlier request has not finished. With the evidence changed it may not be issued again, and
  // it is not given up either: it stays issued, and the executor is kept.
  it("keeps it issued while the request may still act, though the evidence changed since it was authorized (review 9 #5)", async () => {
    const { ledger, state, advance } = await lapsedIssue();
    await changeEvidence(ledger);
    expect(state()).toBe("deleting-issued");
    const settled = await run(
      authorizedDeletion({
        ledger,
        runId: "run_issued",
        runtime: "running",
        removalFenceMs: 20 * 60_000,
        decide: keepRunning,
      }),
    );
    expect(settled.decision.delete).toBe(false);
    expect(settled.heldElsewhere).toBe(true);
    expect(state()).toBe("deleting-issued");
    expect(await run(ledger.openObservation("run_issued", 1_000))).toBeUndefined();
    expect(await run(ledger.admitRecovery("run_issued"))).toBe("deleting");
    // A runtime that gives no bound on a removal request: never given up while it has the
    // executor, however long.
    advance(24 * 60 * 60_000);
    const unbounded = await run(
      authorizedDeletion({ ledger, runId: "run_issued", runtime: "exited", decide: keepRunning }),
    );
    expect(unbounded.heldElsewhere).toBe(true);
    expect(state()).toBe("deleting-issued");
  });

  it("gives it up once the runtime's bound on the request has passed since it was issued (review 9 #5)", async () => {
    const { ledger, state, advance } = await lapsedIssue();
    await changeEvidence(ledger);
    // Issued at 0; the hold lapsed at 121 s. The bound (20 min) has not passed yet.
    const early = await run(
      authorizedDeletion({
        ledger,
        runId: "run_issued",
        runtime: "running",
        removalFenceMs: 20 * 60_000,
        decide: keepRunning,
      }),
    );
    expect(early.heldElsewhere).toBe(true);
    advance(20 * 60_000);
    const settled = await run(
      authorizedDeletion({
        ledger,
        runId: "run_issued",
        runtime: "running",
        removalFenceMs: 20 * 60_000,
        decide: keepRunning,
      }),
    );
    expect(settled.decision.delete).toBe(false);
    expect(settled.heldElsewhere).toBeUndefined();
    expect(state()).toBeUndefined();
    // Decided again on what is current: observations resume.
    expect(await run(ledger.openObservation("run_issued", 1_000))).toBeDefined();
  });

  // Review 9 #5: a runtime call that failed after the provider may have accepted it (a lost
  // reply) is not a refusal: the provider may still act on it.
  it("keeps a removal issued when its runtime call fails with an outcome nobody knows (review 9 #5)", async () => {
    let clock = 0;
    const ledger = inMemoryCaptureDrainLedger({ now: () => clock });
    await run(ledger.recordStatus("run_lost", savedStatus({ headN: 7 }), clock));
    const authorized = await run(
      ledger.authorizeDeletion("run_lost", await versionOf(ledger, "run_lost")),
    );
    if (authorized.kind !== "authorized") {
      throw new Error(authorized.kind);
    }
    const exit = await Effect.runPromise(
      removeUnderDeletion({
        ledger,
        runId: "run_lost",
        ticket: authorized.ticket,
        remove: Effect.tryPromise(async () => {
          throw new Error("socket closed after the request was sent");
        }),
      }).pipe(Effect.exit),
    );
    expect(exit._tag).toBe("Failure");
    const row = ledger.store.rows.get("run_lost");
    expect(row?.deletion?.state).toBe("deleting-issued");
    expect(await run(ledger.admitRecovery("run_lost"))).toBe("deleting");
    expect(await run(ledger.openObservation("run_lost", 1_000))).toBeUndefined();
    // Its hold ended with the call: it is settled from the runtime at once, not 120 s later.
    clock += 1;
    const settled = await run(
      authorizedDeletion({ ledger, runId: "run_lost", runtime: "missing", decide: keepRunning }),
    );
    expect(settled.decision.delete).toBe(false);
    expect(row?.deletion?.state).toBe("deleted");
  });

  it("gives a removal up when the runtime definitively refused it (review 9 #5)", async () => {
    const ledger = inMemoryCaptureDrainLedger();
    await run(ledger.recordStatus("run_refused", savedStatus({ headN: 7 }), 0));
    const authorized = await run(
      ledger.authorizeDeletion("run_refused", await versionOf(ledger, "run_refused")),
    );
    if (authorized.kind !== "authorized") {
      throw new Error(authorized.kind);
    }
    const exit = await Effect.runPromise(
      removeUnderDeletion({
        ledger,
        runId: "run_refused",
        ticket: authorized.ticket,
        remove: Effect.tryPromise(async () => {
          throw removalRefused(new Error("ConflictException: the MicroVM is SUSPENDING"));
        }),
      }).pipe(Effect.exit),
    );
    expect(exit._tag).toBe("Failure");
    expect(ledger.store.rows.get("run_refused")?.deletion).toBeUndefined();
    expect(await run(ledger.admitRecovery("run_refused"))).toBe("admitted");
  });

  // The review's second case: a removal still running past its hold, fresh unsaved evidence
  // recorded without a fence, the runtime reporting the executor present. Nothing reopens before
  // the provider finishes.
  it("admits nothing while a removal whose evidence changed is still with the provider (review 9 #5)", async () => {
    let clock = 0;
    const base = inMemoryCaptureDrainLedger({ now: () => clock });
    const ledger: CaptureDrainLedger = { ...base, confirmDeletion: () => Effect.succeed(false) };
    await run(ledger.recordStatus("run_slow", savedStatus({ headN: 7 }), clock));
    const authorized = await run(
      ledger.authorizeDeletion("run_slow", await versionOf(base, "run_slow")),
    );
    if (authorized.kind !== "authorized") {
      throw new Error(authorized.kind);
    }
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const pending = run(
      removeUnderDeletion({
        ledger,
        runId: "run_slow",
        ticket: authorized.ticket,
        remove: Effect.promise(() => {
          began();
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        }),
      }),
    );
    await started;
    clock = 121_000;
    await run(
      ledger.recordStatus(
        "run_slow",
        captureStatus({ complete: false, incompleteReason: "snapshot-failed", headN: 8 }),
        clock,
      ),
    );
    const decision = await run(
      authorizedDeletion({
        ledger,
        runId: "run_slow",
        runtime: "running",
        removalFenceMs: 20 * 60_000,
        decide: () => ({ delete: false, reason: "new evidence" }),
      }),
    );
    expect(decision.heldElsewhere).toBe(true);
    expect(base.store.rows.get("run_slow")?.deletion?.state).toBe("deleting-issued");
    expect(await run(ledger.admitRecovery("run_slow"))).toBe("deleting");
    expect(await run(ledger.openObservation("run_slow", 1_000))).toBeUndefined();
    finish();
    expect(await pending).toMatchObject({ removed: true });
    expect(base.store.rows.get("run_slow")?.deletion?.state).toBe("deleted");
  });

  it("keeps it issued while its issuer holds it, or while the runtime cannot say", async () => {
    const { ledger, state, advance } = await lapsedIssue();
    const unknown = await run(
      authorizedDeletion({ ledger, runId: "run_issued", runtime: "unknown", decide: keepRunning }),
    );
    expect(unknown.decision.delete).toBe(false);
    expect(unknown.heldElsewhere).toBe(true);
    expect(state()).toBe("deleting-issued");
    // Its issuer's renewal lands again (the database is back): held, whatever the runtime says.
    const current = ledger.store.rows.get("run_issued")?.deletion;
    if (current === undefined) {
      throw new Error("no removal");
    }
    expect(await run(ledger.confirmDeletion("run_issued", { token: current.token }))).toBe(true);
    advance(1_000);
    const held = await run(
      authorizedDeletion({ ledger, runId: "run_issued", runtime: "running", decide: keepRunning }),
    );
    expect(held.heldElsewhere).toBe(true);
    expect(state()).toBe("deleting-issued");
  });
});
