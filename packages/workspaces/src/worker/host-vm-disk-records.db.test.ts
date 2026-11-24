/**
 * A host VM executor's disks on its run's row, against a REAL Postgres: written before the runner
 * exists, read back by its recovery, and listed for base-image GC with whether the executor was
 * removed. Gated on SEALANT_TEST_DATABASE_URL (a disposable database with the migrations applied;
 * it writes rows under fresh ids and leaves them).
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/host-vm-disk-records.db.test.ts
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  SealantDB,
  user,
  workspaceAttempts,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { databaseHostVmDiskRecords } from "./host-vm-disk-records.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
const DIGEST = `sha256:${"cd".repeat(32)}`;

describe.skipIf(DATABASE_URL === undefined)("host VM disk records (Postgres)", () => {
  let db: DB;
  const userId = `user_host_vm_${randomUUID()}`;

  const repo = <A, E>(f: (repo: WorkspaceRuntimeInstanceRepo["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      WorkspaceRuntimeInstanceRepo.use(f).pipe(
        Effect.provide(
          WorkspaceRuntimeInstanceRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db))),
        ),
      ),
    );

  /** A run whose launch has written its `pending` row, as the worker does before `launch`. */
  const pendingRun = async (): Promise<string> => {
    const runId = `run_host_vm_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(workspaceAttempts).values({ id: runId, ownerUserId: userId }),
    );
    await repo((instances) =>
      instances.upsertRuntimeInstance({ runId, status: "pending", sourceKind: "capture" }),
    );
    return runId;
  };

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      db.insert(user).values({ id: userId, name: "host-vm", email: `${userId}@example.test` }),
    );
  });

  it("keeps a run's disks on its row for its recovery, until and after its removal", async () => {
    const runId = await pendingRun();
    const records = databaseHostVmDiskRecords(db);
    const dataDiskPath = `/var/lib/mend/vm-data/sealant-vm-${runId}/data.img`;
    expect(await records.load(runId)).toBeUndefined();

    await records.record({
      runId,
      dataDiskPath,
      baseImageDigest: DIGEST,
      runnerEgress: { mode: "restricted", allowTcpPorts: [5432] },
    });
    expect(await records.load(runId)).toEqual({ dataDiskPath, baseImageDigest: DIGEST });
    // The runner's firewall, for a policy applied while it runs.
    expect(
      (await repo((instances) => instances.getRuntimeInstanceByRunId(runId)))?.hostVmRunnerEgress,
    ).toEqual({ mode: "restricted", allowTcpPorts: [5432] });

    const mine = () =>
      repo((instances) => instances.listHostVmBaseImages()).then((rows) =>
        rows.filter((row) => row.runId === runId),
      );
    expect(await mine()).toEqual([
      { runId, dataDiskPath, baseImageDigest: DIGEST, removed: false },
    ]);

    // The launch's later writes never clear them, and a confirmed removal is what GC reads.
    await repo((instances) =>
      instances.upsertRuntimeInstance({
        runId,
        status: "ready",
        adapter: "host-vm",
        resourceId: `sealant-vm-${runId}`,
        reference: `sealant-vm-${runId}`,
      }),
    );
    await repo((instances) => instances.markRemoved({ runId, resourceId: `sealant-vm-${runId}` }));
    expect(await records.load(runId)).toEqual({ dataDiskPath, baseImageDigest: DIGEST });
    expect(await mine()).toEqual([{ runId, dataDiskPath, baseImageDigest: DIGEST, removed: true }]);
  });

  it("keeps the first instant a claim was asked for, through every later write", async () => {
    const runId = await pendingRun();
    const claimedAt = () =>
      repo((instances) => instances.getRuntimeInstanceByRunId(runId)).then(
        (row) => row?.captureClaimedAt ?? null,
      );
    expect(await claimedAt()).toBeNull();
    await repo((instances) => instances.markCaptureClaimed({ runId }));
    const first = await claimedAt();
    expect(first).toBeInstanceOf(Date);
    await repo((instances) => instances.markCaptureClaimed({ runId }));
    await repo((instances) =>
      instances.upsertRuntimeInstance({ runId, status: "ready", adapter: "host-vm" }),
    );
    expect(await claimedAt()).toEqual(first);
  });

  it("refuses to record disks for a run with no launch row", async () => {
    await expect(
      databaseHostVmDiskRecords(db).record({
        runId: `run_missing_${randomUUID()}`,
        dataDiskPath: "/x/data.img",
        baseImageDigest: DIGEST,
      }),
    ).rejects.toThrow(/No runtime instance exists/);
  });
});
