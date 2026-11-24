/**
 * The egress store against a REAL Postgres: revocations take the workspace's next watermark one
 * at a time and their tombstones accumulate; a run's proxy keeps the CA its first launch wrote; a
 * confirmation never moves backwards; and only the current run's live proxy is swept. Gated on
 * SEALANT_TEST_DATABASE_URL (a disposable, migrated database; rows go under fresh ids).
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/workspace-egress.db.test.ts
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  SealantDB,
  user,
  workspaceAttempts,
  WorkspaceEgressRepo,
  workspaceEgressRepoLayer,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  workspaces,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const proxyInput = (runId: string, workspaceId: string, caCertPem: string) => ({
  runId,
  workspaceId,
  proxyContainer: `sealant-${runId}-proxy`,
  adminSocketPath: `/run/sealant/sockets/sealant-${runId}-proxy/proxy-admin.sock`,
  caCertPem,
  caKeySealed: "v1.k1.sealed",
  encryptionKeyId: "k1",
  caNotAfter: new Date(Date.now() + 86_400_000),
});

describe.skipIf(DATABASE_URL === undefined)("the workspace egress store (Postgres)", () => {
  let db: DB;
  const userId = `user_egress_${randomUUID()}`;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      db.insert(user).values({ id: userId, name: "egress", email: `${userId}@example.test` }),
    );
  });

  const run = <A, E>(
    effect: Effect.Effect<A, E, WorkspaceEgressRepo | WorkspaceRuntimeInstanceRepo>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(workspaceEgressRepoLayer, WorkspaceRuntimeInstanceRepoLive).pipe(
            Layer.provide(Layer.succeed(SealantDB, db)),
          ),
        ),
      ),
    );

  const workspaceWithRun = async (
    status: "ready" | "stopped" = "ready",
    options: { readonly restartedSince?: boolean } = {},
  ) => {
    const workspaceId = `ws_egress_${randomUUID()}`;
    const runId = `run_egress_${randomUUID()}`;
    const latestRunId = options.restartedSince === true ? `run_egress_${randomUUID()}` : runId;
    for (const id of new Set([runId, latestRunId])) {
      await Effect.runPromise(db.insert(workspaceAttempts).values({ id, ownerUserId: userId }));
    }
    await Effect.runPromise(
      db.insert(workspaces).values({ id: workspaceId, ownerUserId: userId, latestRunId }),
    );
    await run(
      Effect.gen(function* () {
        yield* (yield* WorkspaceRuntimeInstanceRepo).upsertRuntimeInstance({
          runId,
          status,
          adapter: "docker",
          resourceId: `container-${runId}`,
          launchCredentialInjections: [],
        });
      }),
    );
    return { workspaceId, runId };
  };

  it("gives each revocation the next watermark and keeps every tombstone, even with no policy stored", async () => {
    const { workspaceId } = await workspaceWithRun();
    const tombstones = await run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceEgressRepo;
        const [first, second] = yield* Effect.all(
          [
            repo.revoke({ workspaceId, secretIds: ["psec_a"], hosts: [], all: false }),
            repo.revoke({ workspaceId, secretIds: [], hosts: ["API.example.com"], all: false }),
          ],
          // Concurrent on purpose: the watermark row serialises them.
          { concurrency: "unbounded" },
        );
        const third = yield* repo.revoke({
          workspaceId,
          secretIds: ["psec_a"],
          hosts: [],
          all: true,
        });
        return { first, second, third };
      }),
    );
    expect(
      [tombstones.first.revocationWatermark, tombstones.second.revocationWatermark].toSorted(
        (left, right) => left - right,
      ),
    ).toEqual([1, 2]);
    expect(tombstones.third).toEqual({
      revocationWatermark: 3,
      revokedSecretIds: ["psec_a"],
      revokedHosts: ["api.example.com"],
      revokedAll: true,
    });
  });

  it("keeps a policy's revocations when the policy is replaced", async () => {
    const { workspaceId } = await workspaceWithRun();
    const after = await run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceEgressRepo;
        yield* repo.putPolicy({
          workspaceId,
          networkPolicy: { mode: "standard", policyHash: "h1" },
          brokeredSecrets: [],
          brokeredValuesSealed: undefined,
          encryptionKeyId: undefined,
        });
        yield* repo.revoke({ workspaceId, secretIds: ["psec_b"], hosts: [], all: false });
        yield* repo.putPolicy({
          workspaceId,
          networkPolicy: { mode: "restricted", policyHash: "h2" },
          brokeredSecrets: [],
          brokeredValuesSealed: undefined,
          encryptionKeyId: undefined,
        });
        return {
          policy: yield* repo.getPolicy(workspaceId),
          tombstones: yield* repo.tombstones(workspaceId),
        };
      }),
    );
    expect(after.policy?.networkPolicy?.policyHash).toBe("h2");
    expect(after.tombstones).toMatchObject({
      revocationWatermark: 1,
      revokedSecretIds: ["psec_b"],
    });
  });

  it("keeps the CA a run's first launch wrote, and never moves a confirmation backwards", async () => {
    const { workspaceId, runId } = await workspaceWithRun();
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceEgressRepo;
        const first = yield* repo.ensureProxy(proxyInput(runId, workspaceId, "CA-1"));
        const again = yield* repo.ensureProxy(proxyInput(runId, workspaceId, "CA-2"));
        yield* repo.confirmProxy({ runId, policyHash: "h", revocationWatermark: 5 });
        yield* repo.confirmProxy({ runId, policyHash: "old", revocationWatermark: 4 });
        return { first, again, stored: yield* repo.getProxy(runId) };
      }),
    );
    expect(result.first.created).toBe(true);
    expect(result.again).toMatchObject({ created: false, proxy: { caCertPem: "CA-1" } });
    expect(result.stored).toMatchObject({
      confirmedPolicyHash: "h",
      confirmedRevocationWatermark: 5,
    });
  });

  it("sweeps only the current run's proxy, and only while its executor may run", async () => {
    const live = await workspaceWithRun("ready");
    const stopped = await workspaceWithRun("stopped");
    // A restart moved this workspace on to a newer run: its old run's proxy is not the current one.
    const replaced = await workspaceWithRun("ready", { restartedSince: true });
    const listed = await run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceEgressRepo;
        for (const each of [live, stopped, replaced]) {
          yield* repo.ensureProxy(proxyInput(each.runId, each.workspaceId, "CA"));
        }
        return yield* repo.listLiveProxies();
      }),
    );
    const runs = listed.map((row) => row.proxy.runId);
    expect(runs).toContain(live.runId);
    expect(runs).not.toContain(stopped.runId);
    expect(runs).not.toContain(replaced.runId);
  });

  it("leaves a proxy to the stop under way: no sweep sees it once its stop is requested", async () => {
    const { workspaceId, runId } = await workspaceWithRun("ready");
    const before = await run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceEgressRepo;
        yield* repo.ensureProxy(proxyInput(runId, workspaceId, "CA"));
        return yield* repo.listLiveProxies();
      }),
    );
    const after = await run(
      Effect.gen(function* () {
        yield* (yield* WorkspaceRuntimeInstanceRepo).markStopRequested({
          runId,
          stopReason: "user",
        });
        return yield* (yield* WorkspaceEgressRepo).listLiveProxies();
      }),
    );
    expect(before.map((row) => row.proxy.runId)).toContain(runId);
    expect(after.map((row) => row.proxy.runId)).not.toContain(runId);
  });

  it("bumps the policy revision on every write, a value-only rotation included, and confirms it forward only", async () => {
    const { workspaceId, runId } = await workspaceWithRun();
    const put = {
      workspaceId,
      networkPolicy: { mode: "standard" as const, policyHash: "h" },
      brokeredSecrets: [],
      encryptionKeyId: "k1",
    };
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceEgressRepo;
        const first = yield* repo.putPolicy({ ...put, brokeredValuesSealed: "v1.k1.a" });
        const rotated = yield* repo.putPolicy({ ...put, brokeredValuesSealed: "v1.k1.b" });
        yield* repo.ensureProxy(proxyInput(runId, workspaceId, "CA"));
        yield* repo.confirmProxy({
          runId,
          policyHash: "h",
          revocationWatermark: 0,
          policyRevision: rotated.policyRevision,
        });
        yield* repo.confirmProxy({
          runId,
          policyHash: "h",
          revocationWatermark: 0,
          policyRevision: first.policyRevision,
        });
        return { first, rotated, proxy: yield* repo.getProxy(runId) };
      }),
    );
    // A first write is revision 1, above the 0 a run with no stored policy confirms.
    expect(result.first.policyRevision).toBe(1);
    expect(result.rotated.policyRevision).toBe(2);
    expect(result.proxy?.confirmedPolicyRevision).toBe(result.rotated.policyRevision);
  });

  it("moves a policy applied after a revocation of everything past it, keeping what was revoked by name", async () => {
    const { workspaceId } = await workspaceWithRun();
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* WorkspaceEgressRepo;
        yield* repo.putPolicy({
          workspaceId,
          networkPolicy: {
            mode: "restricted",
            policyHash: "h1",
            allowHosts: [{ host: "old.example.com" }],
          },
          brokeredSecrets: [],
          brokeredValuesSealed: undefined,
          encryptionKeyId: undefined,
        });
        const revoked = yield* repo.revoke({
          workspaceId,
          secretIds: [],
          hosts: ["old.example.com"],
          all: true,
        });
        const applied = yield* repo.putPolicy({
          workspaceId,
          networkPolicy: {
            mode: "restricted",
            policyHash: "h2",
            allowHosts: [{ host: "new.example.com" }],
          },
          brokeredSecrets: [],
          brokeredValuesSealed: undefined,
          encryptionKeyId: undefined,
        });
        const again = yield* repo.putPolicy({
          workspaceId,
          networkPolicy: { mode: "restricted", policyHash: "h3" },
          brokeredSecrets: [],
          brokeredValuesSealed: undefined,
          encryptionKeyId: undefined,
        });
        return { revoked, applied, again, tombstones: yield* repo.tombstones(workspaceId) };
      }),
    );
    expect(result.applied.revocationWatermark).toBe(result.revoked.revocationWatermark + 1);
    // Past the revocation of everything once: a later write leaves the watermark where it is.
    expect(result.again.revocationWatermark).toBe(result.applied.revocationWatermark);
    expect(result.tombstones.revokedHosts).toEqual(["old.example.com"]);
  });
});
