/**
 * The preservation policy's two review-4 rules (#1): recorded evidence lets only an executor
 * that ENDED go (a running one is drained first), and an attestation is weighed against Core's
 * own observations — a newer report that the work is not saved revokes an older seal.
 */
import { describe, expect, it } from "vitest";

import {
  attestationCoversExecutor,
  decideExecutorDeletion,
  observedCaptureFromStored,
} from "./executor-preservation.js";

const executor = { runId: "run_1", resourceId: "container-1", reference: "sealant-run-1" };
const SEALED_AT = Date.parse("2026-09-28T00:00:00.000Z");
/** A position in the executor's own history (sealantd's stamp). */
const at = (observation: number, headN = 41) => ({
  epoch: 3,
  launch: "launch-1",
  bootId: "boot-1",
  bootGeneration: 1,
  observation,
  headN,
});
const seal = {
  executorId: "container-1",
  epoch: 3,
  captureN: 41,
  sealedAtMs: SEALED_AT,
  origin: at(100),
};
const failedAt = (atMs: number, headN = 41, origin?: ReturnType<typeof at>) =>
  observedCaptureFromStored(
    {
      epoch: 3,
      headN,
      complete: false,
      incompleteReason: "snapshot-failed",
      unreadable: 1,
      ...(origin === undefined ? {} : { origin }),
    },
    atMs,
  );

describe("decideExecutorDeletion · recorded evidence and a running executor", () => {
  it("never lets a running or unknown executor go on recorded evidence; a drain now does", () => {
    for (const runtime of ["running", "unknown"] as const) {
      expect(
        decideExecutorDeletion({
          captureSourced: true,
          runtime,
          observedComplete: true,
          attestedComplete: true,
        }).delete,
      ).toBe(false);
    }
    expect(
      decideExecutorDeletion({ captureSourced: true, runtime: "running", drainedNow: true }),
    ).toEqual({ delete: true, basis: "observed-complete" });
    expect(
      decideExecutorDeletion({ captureSourced: true, runtime: "running", discarded: true }),
    ).toEqual({ delete: true, basis: "discarded" });
    expect(
      decideExecutorDeletion({ captureSourced: true, runtime: "exited", attestedComplete: true }),
    ).toEqual({ delete: true, basis: "attested-complete" });
  });
});

describe("attestationCoversExecutor · freshness", () => {
  it("is revoked by a failed observation the executor made at or after the seal", () => {
    expect(
      attestationCoversExecutor(seal, executor, failedAt(SEALED_AT + 1_000, 41, at(101))).covers,
    ).toBe(false);
    expect(
      attestationCoversExecutor(seal, executor, failedAt(SEALED_AT + 1_000, 41, at(100))).covers,
    ).toBe(false);
  });

  it("stands over a failed observation the executor made before the seal, or before its capture existed", () => {
    expect(
      attestationCoversExecutor(seal, executor, failedAt(SEALED_AT + 1_000, 41, at(99))).covers,
    ).toBe(true);
    expect(attestationCoversExecutor(seal, executor, failedAt(SEALED_AT + 1_000, 40)).covers).toBe(
      true,
    );
  });

  // Review 6 #6: clocks order nothing. A failed observation read by a Core worker whose clock is
  // an hour behind the store's still counts against the seal when the executor's own history does
  // not place it before the seal; one without any position cannot be placed at all.
  it("never lets a clock place an observation before the seal", () => {
    expect(
      attestationCoversExecutor(seal, executor, failedAt(SEALED_AT - 3_600_000, 41, at(101)))
        .covers,
    ).toBe(false);
    expect(attestationCoversExecutor(seal, executor, failedAt(SEALED_AT - 3_600_000)).covers).toBe(
      false,
    );
    // Another boot of the same launch under the same generation: cannot be ordered.
    expect(
      attestationCoversExecutor(
        seal,
        executor,
        failedAt(SEALED_AT - 3_600_000, 41, { ...at(1), bootId: "boot-2" }),
      ).covers,
    ).toBe(false);
  });

  it("is revoked by a later capture than the sealed one, whatever its time", () => {
    expect(
      attestationCoversExecutor(
        seal,
        executor,
        observedCaptureFromStored({ epoch: 3, headN: 42, complete: true }, SEALED_AT - 3_600_000),
      ).covers,
    ).toBe(false);
  });

  it("without a seal position, is revoked by any incomplete observation at its capture", () => {
    const { origin: _dropped, ...untimed } = seal;
    expect(
      attestationCoversExecutor(untimed, executor, failedAt(SEALED_AT - 3_600_000)).covers,
    ).toBe(false);
    expect(
      attestationCoversExecutor(
        untimed,
        executor,
        observedCaptureFromStored({ epoch: 3, headN: 41, complete: true }, SEALED_AT),
      ).covers,
    ).toBe(true);
  });

  it("fails closed on a stored observation it cannot read, and stands with none at all", () => {
    expect(
      attestationCoversExecutor(seal, executor, observedCaptureFromStored({ pending: 1 }, 0))
        .covers,
    ).toBe(false);
    expect(attestationCoversExecutor(seal, executor, undefined).covers).toBe(true);
  });
});
