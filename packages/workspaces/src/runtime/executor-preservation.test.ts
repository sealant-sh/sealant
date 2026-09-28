/**
 * The preservation policy's two review-4 rules (#1): recorded evidence lets only an executor
 * that ENDED go (a running one is drained first), and an attestation is weighed against Core's
 * own observations — a newer report that the work is not saved revokes an older seal.
 */
import { describe, expect, it } from "vitest";

import {
  ATTESTATION_CLOCK_SKEW_MS,
  attestationCoversExecutor,
  decideExecutorDeletion,
  observedCaptureFromStored,
} from "./executor-preservation.js";

const executor = { runId: "run_1", resourceId: "container-1", reference: "sealant-run-1" };
const SEALED_AT = Date.parse("2026-09-28T00:00:00.000Z");
const seal = { executorId: "container-1", epoch: 3, captureN: 41, sealedAtMs: SEALED_AT };
const failedAt = (atMs: number, headN = 41) =>
  observedCaptureFromStored(
    { epoch: 3, headN, complete: false, incompleteReason: "snapshot-failed", unreadable: 1 },
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
  it("is revoked by a failed observation read after the seal, or inside the clock-skew window", () => {
    expect(attestationCoversExecutor(seal, executor, failedAt(SEALED_AT + 1_000)).covers).toBe(
      false,
    );
    expect(
      attestationCoversExecutor(
        seal,
        executor,
        failedAt(SEALED_AT - ATTESTATION_CLOCK_SKEW_MS + 1_000),
      ).covers,
    ).toBe(false);
  });

  it("stands over a failed observation read well before the seal, or before its capture existed", () => {
    expect(
      attestationCoversExecutor(
        seal,
        executor,
        failedAt(SEALED_AT - ATTESTATION_CLOCK_SKEW_MS - 1_000),
      ).covers,
    ).toBe(true);
    expect(attestationCoversExecutor(seal, executor, failedAt(SEALED_AT + 1_000, 40)).covers).toBe(
      true,
    );
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

  it("without a seal time, is revoked by any incomplete observation at its capture", () => {
    const { sealedAtMs: _dropped, ...untimed } = seal;
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
