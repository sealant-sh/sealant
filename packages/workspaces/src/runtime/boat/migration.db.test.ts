import { randomUUID } from "node:crypto";

import { CredentialCipher, credentialCipherLayer } from "@sealant/credentials";
import {
  BoatRunRepo,
  BoatRunRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  makeSealantDBLayer,
} from "@sealant/db";
import { withDatabaseBeforeMigration } from "@sealant/db/testing/workspace-publications";
import {
  boatExecutionTargetSchema,
  boatRunLaunchPhase,
  boatRunVmPhase,
  type BoatExecutionTarget,
} from "@sealant/validators";
import { Effect, Layer, Logger } from "effect";
import { describe, expect, it } from "vitest";

import { verifyBoatBearers } from "../../worker/boat-allocation.js";
import { GuestFixture } from "./allocation.fixture.js";
import { BoatExecution, BoatGuestTransportService, boatExecutionLayer } from "./execution.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
/** The migration that replaces the three ledgers with `boat_runs`. */
const MIGRATION = "20261110223249_boat_runs";
const DEPLOYMENT = "test";
const BEARER = "a".repeat(64);
const OPERATION = `bdop_${"c".repeat(32)}`;
const cipherLayer = credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") });

type Before = Parameters<Parameters<typeof withDatabaseBeforeMigration>[2]>[0];
type Sql = Before["client"];

/** A valid VM id, different for every seeded run. */
const sandboxOf = (index: number) => {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  let id = "";
  for (let rest = index, place = 0; place < 8; place += 1, rest = Math.floor(rest / 31))
    id = `${alphabet[rest % 31] ?? "2"}${id}`;
  return `bx_${id}`;
};

/** What one run held in the three ledgers before the migration. */
interface Ledgers {
  readonly allocation: {
    readonly phase: "reserved" | "issued" | "allocated" | "bound" | "held" | "deleting" | "deleted";
    readonly reason?: string;
    readonly removal?: Record<string, unknown>;
    /** When create was issued; absent for a record from before issue times were kept. */
    readonly issuedAt?: string;
    readonly conflictingSandboxes?: readonly string[];
    readonly resources?: "none";
  };
  readonly execution?: {
    readonly phase:
      | "exchange"
      | "control"
      /** Written until #515: bearer sealed and launch material staged, nothing pushed. */
      | "prepared"
      | "installed"
      | "issued"
      | "running"
      | "held"
      | "aborted";
    readonly isolation?: unknown;
    /** `false`: a record from before the launch material was kept past its push. */
    readonly resume?: boolean;
  };
  readonly observation?: {
    readonly presence: "present" | "absent";
    readonly basis: "read" | "not-found" | "deletion-completed" | "not-discovered";
    readonly created?: boolean;
  };
  readonly tunnel?: {
    readonly removal?: { readonly id: string; readonly completed: boolean };
    readonly released?: boolean;
  };
}

interface Seeded {
  readonly runId: string;
  readonly sandboxId: string | null;
  readonly target: BoatExecutionTarget | null;
  readonly exchangeId: string;
  readonly sealedControl: string | null;
  readonly sealedEnvelope: string;
  readonly createdAt: Date;
  readonly observedAt: Date;
}

const RECEIPTS = { resourceReceipt: "e".repeat(64), tunnelReceipt: "f".repeat(64) };

/** Writes the old tables as the earlier code left them, sealing with the real cipher. */
const seeder = (client: Sql, cipher: CredentialCipher["Service"]) => {
  let count = 0;
  const gatewayHostId = randomUUID();
  /** The earlier code's seal: `{context: {target, exchangeId, purpose}, value}`, encrypted. */
  const seal = (target: BoatExecutionTarget, exchangeId: string, purpose: string, value: unknown) =>
    Effect.runPromise(
      cipher
        .encrypt(JSON.stringify({ context: { target, exchangeId, purpose }, value }))
        .pipe(Effect.map((sealed) => sealed.sealed)),
    );
  return async (ledgers: Ledgers): Promise<Seeded> => {
    count += 1;
    const { allocation, execution, observation, tunnel } = ledgers;
    const runId = randomUUID();
    const ownerUserId = `usr_${randomUUID()}`;
    const publicationId = randomUUID();
    const idempotencyKey = randomUUID();
    const diskLineage = randomUUID();
    const exchangeId = randomUUID();
    const createdAt = new Date(Date.now() - 3 * 60 * 60_000);
    const observedAt = new Date(Date.now() - 60 * 60_000);
    const removalKind = allocation.removal?.["kind"];
    const hasVm =
      ["allocated", "bound", "deleting"].includes(allocation.phase) ||
      (allocation.phase === "held" && allocation.reason === "lifetime-unverified") ||
      (allocation.phase === "deleted" && removalKind !== "never-created");
    const sandboxId = hasVm ? sandboxOf(count) : null;
    const target =
      sandboxId !== null && execution !== undefined
        ? boatExecutionTargetSchema.parse({
            deploymentId: DEPLOYMENT,
            workspaceId: "workspace",
            runId,
            runtimeInstanceId: runId,
            launchAttemptId: "attempt",
            sourceId: publicationId,
            sandboxId,
            diskLineage,
            bootId: randomUUID(),
            manifestDigest: "b".repeat(64),
          })
        : null;
    await client.query(
      `insert into "user" (id, name, email, created_at, updated_at) values ($1, 'migration', $2, now(), now())`,
      [ownerUserId, `${ownerUserId}@example.invalid`],
    );
    await client.query(
      `insert into workspace_attempts (id, owner_user_id, queued_at, created_at, updated_at) values ($1, $2, now(), now(), now())`,
      [runId, ownerUserId],
    );
    await client.query(
      `insert into native_publications (id, build_id, key_hash, key_payload, deployment_id, scope_kind, scope_id, recipe_hash)
       values ($1, $2, $3, '{}', $4, 'owner', $5, $6)`,
      [publicationId, randomUUID(), randomUUID(), DEPLOYMENT, ownerUserId, "e".repeat(64)],
    );
    const removal =
      allocation.removal === undefined
        ? undefined
        : removalKind === "operation" || removalKind === "absent"
          ? { ...allocation.removal, targetId: sandboxId }
          : allocation.removal;
    await client.query(
      `insert into boat_allocations (runtime_instance_id, deployment_id, publication_id, idempotency_key, disk_lineage, sandbox_id, record, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        runId,
        DEPLOYMENT,
        publicationId,
        idempotencyKey,
        diskLineage,
        sandboxId,
        JSON.stringify({
          input: {
            deploymentId: DEPLOYMENT,
            workspaceId: "workspace",
            consumer: { runId, runtimeInstanceId: runId },
            launchAttemptId: "attempt",
            publication: {
              kind: "boat-native",
              publicationId,
              snapshot: { identity: { name: `snapshot-${runId}` } },
            },
            scope: { kind: "owner", ownerUserId },
            sourceKind: "capture",
            ...(allocation.resources === undefined ? {} : { resources: allocation.resources }),
          },
          idempotencyKey,
          diskLineage,
          manifestDigest: "b".repeat(64),
          ...(allocation.issuedAt === undefined ? {} : { issuedAt: allocation.issuedAt }),
          phase: allocation.phase,
          sandboxId,
          conflictingSandboxes: allocation.conflictingSandboxes ?? [],
          target,
          reason: allocation.reason ?? null,
          ...(removal === undefined ? {} : { removal }),
        }),
        createdAt,
      ],
    );
    let sealedControl: string | null = null;
    let sealedEnvelope = "";
    if (execution !== undefined && target !== null) {
      const { phase } = execution;
      sealedEnvelope = await seal(target, exchangeId, "admission", { launch: runId });
      if (phase !== "exchange" && phase !== "aborted")
        sealedControl = await seal(target, exchangeId, "control", {
          origin: "https://vm.example.invalid",
          cookie: "hosted-cookie-local-only",
          bearer: BEARER,
        });
      const staged = ["prepared", "installed", "issued", "running", "held"].includes(phase);
      // A record of the launch script's time: no `docker`, no copy kept past the push.
      const legacy = phase === "prepared";
      const pushed = phase === "running" || phase === "held";
      await client.query(
        `insert into boat_executions (runtime_instance_id, run_id, deployment_id, sandbox_id, disk_lineage, record)
         values ($1, $1, $2, $3, $4, $5)`,
        [
          runId,
          DEPLOYMENT,
          target.sandboxId,
          target.diskLineage,
          JSON.stringify({
            target,
            exchangeId,
            publicKey: phase === "aborted" ? "" : "p".repeat(120),
            sealedExchange:
              phase === "exchange"
                ? await seal(target, exchangeId, "exchange", { privateKey: "local-only" })
                : null,
            sealedControl,
            admission: staged
              ? {
                  operationId: exchangeId,
                  epoch: 1,
                  digest: "d".repeat(64),
                  ...(legacy ? {} : { docker: false }),
                  sealedEnvelope: pushed ? null : sealedEnvelope,
                  ...(execution.resume === false || legacy
                    ? {}
                    : { sealedResumeEnvelope: sealedEnvelope }),
                }
              : null,
            ...(execution.isolation === undefined ? {} : { isolation: execution.isolation }),
            phase,
          }),
        ],
      );
    }
    if (observation !== undefined)
      await client.query(
        `insert into boat_observations (runtime_instance_id, deployment_id, sandbox_id, presence, basis, provider_state, created_observed_at, observed_at)
         values ($1, $2, $3, $4, $5, 'idle', $6, $7)`,
        [
          runId,
          DEPLOYMENT,
          observation.basis === "not-discovered" ? null : sandboxId,
          observation.presence,
          observation.basis,
          observation.created === false ? null : new Date(observedAt.getTime() - 60_000),
          observedAt,
        ],
      );
    if (tunnel !== undefined && target !== null) {
      const reservationId = randomUUID();
      const listenPort = 61000 + count;
      await client.query(
        `insert into boat_tunnels (runtime_instance_id, gateway_host_id, listen_port, reservation_id, record, released_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          runId,
          gatewayHostId,
          listenPort,
          reservationId,
          JSON.stringify({
            binding: { target, gatewayHostId },
            reservationId,
            listenPort,
            material: null,
            ...(tunnel.removal === undefined && tunnel.released !== true
              ? {}
              : { closeId: randomUUID() }),
            ...(tunnel.removal === undefined ? {} : { removal: tunnel.removal }),
            ...(tunnel.released === true ? { released: true, absent: true } : {}),
          }),
          tunnel.released === true ? observedAt : null,
        ],
      );
    }
    return {
      runId,
      sandboxId,
      target,
      exchangeId,
      sealedControl,
      sealedEnvelope,
      createdAt,
      observedAt,
    };
  };
};

/** The carried row, read through the repository (which parses it), with both of its phases. */
const carried = (repo: BoatRunRepo["Service"]) => async (seeded: Seeded) => {
  const run = await Effect.runPromise(repo.get(seeded.runId));
  if (run === undefined) throw new Error(`run ${seeded.runId} was not carried`);
  return { run, vm: boatRunVmPhase(run), launch: boatRunLaunchPhase(run) };
};

/** The new code over the upgraded database: the repositories and the real seal. */
const upgraded = async <A>(
  url: string,
  run: (services: {
    readonly repo: BoatRunRepo["Service"];
    readonly tunnels: BoatTunnelRepo["Service"];
    readonly executor: BoatExecution["Service"];
  }) => Promise<A>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* BoatRunRepo;
      const tunnels = yield* BoatTunnelRepo;
      const executor = yield* BoatExecution;
      return yield* Effect.promise(() => run({ repo, tunnels, executor }));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(boatExecutionLayer, BoatRunRepoLive, boatTunnelRepoLayer).pipe(
          Layer.provide(
            Layer.mergeAll(
              makeSealantDBLayer(url),
              cipherLayer,
              Layer.succeed(BoatGuestTransportService, new GuestFixture()),
            ),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );

const withCipher = <A>(run: (cipher: CredentialCipher["Service"]) => Promise<A>) =>
  Effect.runPromise(
    Effect.flatMap(CredentialCipher, (cipher) => Effect.promise(() => run(cipher))).pipe(
      Effect.provide(cipherLayer),
    ),
  );

const before = <A>(run: (context: Before, seed: ReturnType<typeof seeder>) => Promise<A>) => {
  if (databaseUrl === undefined) throw new Error("SEALANT_TEST_DATABASE_URL required");
  return withCipher((cipher) =>
    withDatabaseBeforeMigration(databaseUrl, MIGRATION, (context) =>
      run(context, seeder(context.client, cipher)),
    ),
  );
};

/** What a migration that refused said, through whatever the runner wrapped it in. */
const refusal = (upgrade: Promise<void>) =>
  upgrade.then(
    () => "the migration was applied",
    (error: unknown) => {
      const said: string[] = [];
      for (let current = error, depth = 0; current instanceof Error && depth < 8; depth += 1) {
        said.push(current.message);
        current = current.cause;
      }
      return said.join("\n");
    },
  );
const instant = expect.any(Date);
const launchedBare = { launchIssuedAt: null, launchAcceptedAt: null, fencedAt: null };

describe.runIf(databaseUrl !== undefined)(
  "boat_runs migration: the three ledgers carried to one row",
  () => {
    it("carries every launch state with its sealed values as they were, and each carried bearer opens with the real seal code", () =>
      before(async ({ url, upgrade }, seed) => {
        const present = { presence: "present", basis: "read" } as const;
        // A session running across the upgrade, with its tunnel configured.
        const running = await seed({
          allocation: { phase: "bound", issuedAt: new Date(Date.now() - 7_200_000).toISOString() },
          execution: { phase: "running", isolation: RECEIPTS },
          observation: present,
          tunnel: {},
        });
        // The same, launched never to be linked to resources: no tunnel.
        const unlinked = await seed({
          allocation: { phase: "bound", resources: "none" },
          execution: { phase: "running", isolation: { resources: "none" } },
          observation: present,
        });
        // Launched before the launch material was kept past its push, and before isolation was recorded.
        const early = await seed({
          allocation: { phase: "bound" },
          execution: { phase: "running", resume: false },
          observation: present,
        });
        // A launch in flight: its bind exchange unanswered.
        const binding = await seed({
          allocation: { phase: "bound" },
          execution: { phase: "exchange" },
          observation: present,
        });
        // A launch in flight: its bearer sealed, nothing staged.
        const control = await seed({
          allocation: { phase: "bound" },
          execution: { phase: "control" },
        });
        // A launch in flight: staged and not pushed.
        const staged = await seed({
          allocation: { phase: "bound" },
          execution: { phase: "installed" },
          observation: present,
        });
        // A launch that failed at the guest install of the launch script's time (before #515):
        // staged, never pushed, and its row left in a phase no later code writes.
        const prepared = await seed({
          allocation: { phase: "bound" },
          execution: { phase: "prepared" },
          observation: present,
        });
        // A launch whose push was issued, with an unknown outcome.
        const issued = await seed({
          allocation: { phase: "bound" },
          execution: { phase: "issued", isolation: RECEIPTS },
          observation: present,
          tunnel: {},
        });
        // A session a stop fenced, awaiting its FINAL.
        const held = await seed({
          allocation: { phase: "bound" },
          execution: { phase: "held", isolation: RECEIPTS },
          observation: present,
          tunnel: {},
        });
        // A VM fenced before any launch was pushed.
        const aborted = await seed({
          allocation: { phase: "bound" },
          execution: { phase: "aborted" },
          observation: present,
        });
        await upgrade();
        await upgraded(url, async ({ repo, tunnels, executor }) => {
          const read = carried(repo);
          const opens = (seeded: Seeded) => Effect.runPromise(executor.verifyBearer(seeded.runId));

          const r = await read(running);
          expect(r).toMatchObject({ vm: "bound", launch: "running" });
          expect(r.run).toMatchObject({
            runId: running.runId,
            deploymentId: DEPLOYMENT,
            workspaceId: "workspace",
            launchAttemptId: "attempt",
            manifestDigest: "b".repeat(64),
            snapshotName: `snapshot-${running.runId}`,
            resources: null,
            sandboxId: running.sandboxId,
            // Copied as they were: the seal opens only under exactly this target and exchange.
            target: running.target,
            exchangeId: running.exchangeId,
            sealedControl: running.sealedControl,
            sealedExchange: null,
            admissionOperationId: running.exchangeId,
            admissionEpoch: 1,
            admissionDigest: "d".repeat(64),
            docker: false,
            sealedLaunch: running.sealedEnvelope,
            isolation: RECEIPTS,
            launchIssuedAt: instant,
            launchAcceptedAt: instant,
            fencedAt: null,
            createdSeenAt: new Date(running.observedAt.getTime() - 60_000),
            deletionClaimedAt: null,
            deletionOperationId: null,
            absentAt: null,
            heldReason: null,
            conflictingSandboxes: [],
          });
          expect(r.run.createIssuedAt?.getTime()).toBeLessThan(
            running.createdAt.getTime() + 3_700_000,
          );
          await opens(running);
          // Its tunnel reservation still belongs to it, on the run's row now.
          expect(await Effect.runPromise(tunnels.get(running.runId))).toMatchObject({
            binding: { target: running.target },
          });

          const u = await read(unlinked);
          expect(u).toMatchObject({ vm: "bound", launch: "running" });
          expect(u.run).toMatchObject({ resources: "none", isolation: { resources: "none" } });
          await opens(unlinked);
          expect(await Effect.runPromise(tunnels.get(unlinked.runId))).toBeUndefined();

          // A session from before isolation and the kept launch material: still a running session
          // with a bearer that opens, so its FINAL can still be drained.
          const e = await read(early);
          expect(e).toMatchObject({ vm: "bound", launch: "running" });
          expect(e.run).toMatchObject({ sealedLaunch: null, isolation: null, fencedAt: null });
          await opens(early);

          const b = await read(binding);
          expect(b).toMatchObject({ vm: "bound", launch: "exchange" });
          expect(b.run).toMatchObject({
            exchangeId: binding.exchangeId,
            exchangePublicKey: "p".repeat(120),
            sealedExchange: expect.any(String),
            sealedControl: null,
            ...launchedBare,
          });

          const c = await read(control);
          expect(c).toMatchObject({ vm: "bound", launch: "control" });
          expect(c.run).toMatchObject({ admissionOperationId: null, createdSeenAt: null });
          expect(c.run).toMatchObject(launchedBare);
          await opens(control);

          // Never carried as launched: nothing was pushed, so nothing ran.
          const s = await read(staged);
          expect(s).toMatchObject({ vm: "bound", launch: "installed" });
          expect(s.run).toMatchObject({ sealedLaunch: staged.sealedEnvelope, ...launchedBare });
          await opens(staged);

          // The same for the phase that came before `installed`: carried, not refused.
          const p = await read(prepared);
          expect(p).toMatchObject({ vm: "bound", launch: "installed" });
          expect(p.run).toMatchObject({
            sealedLaunch: prepared.sealedEnvelope,
            docker: false,
            ...launchedBare,
          });
          await opens(prepared);

          // Never carried as never launched: its push was issued, whatever became of it.
          const i = await read(issued);
          expect(i).toMatchObject({ vm: "bound", launch: "issued" });
          expect(i.run).toMatchObject({
            launchIssuedAt: instant,
            launchAcceptedAt: null,
            fencedAt: null,
            sealedLaunch: issued.sealedEnvelope,
          });
          await opens(issued);
          // The fence the recovery takes says a daemon may have run on it.
          expect(await Effect.runPromise(repo.fence(issued.runId))).toMatchObject({
            launchIssuedAt: instant,
            sealedControl: issued.sealedControl,
          });

          const h = await read(held);
          expect(h).toMatchObject({ vm: "bound", launch: "held" });
          expect(h.run).toMatchObject({ launchIssuedAt: instant, fencedAt: instant });
          await opens(held);

          const a = await read(aborted);
          expect(a).toMatchObject({ vm: "bound", launch: "aborted" });
          expect(a.run).toMatchObject({
            launchIssuedAt: null,
            fencedAt: instant,
            sealedControl: null,
            exchangePublicKey: null,
          });

          // What the worker does at start: every live bearer opens, and it says so.
          const logged: string[] = [];
          const checked = await Effect.runPromise(
            verifyBoatBearers(DEPLOYMENT).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.succeed(BoatRunRepo, repo),
                  Layer.succeed(BoatExecution, executor),
                  Logger.layer([Logger.make(({ message }) => void logged.push(String(message)))]),
                ),
              ),
            ),
          );
          expect(checked).toEqual({ checked: 8, unopened: [] });
          expect(logged).toEqual([]);
        });
      }));

    it("carries every VM state: create issued or not, held for an operator, and each way Boat or Core knows a VM is gone", () =>
      before(async ({ url, upgrade }, seed) => {
        const issuedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
        const created = { presence: "present", basis: "read" } as const;
        const reserved = await seed({ allocation: { phase: "reserved" } });
        const issued = await seed({ allocation: { phase: "issued", issuedAt } });
        // Issued before issue times were kept: its reservation's time stands for it.
        const undated = await seed({ allocation: { phase: "issued" } });
        // An issue time in the future says nothing of the key's age: never replayed.
        const future = await seed({
          allocation: { phase: "issued", issuedAt: new Date(Date.now() + 3_600_000).toISOString() },
        });
        const allocated = await seed({
          allocation: { phase: "allocated", issuedAt },
          observation: { ...created, created: false },
        });
        const unresolved = await seed({
          allocation: { phase: "held", reason: "create-unresolved", issuedAt },
        });
        const conflict = await seed({
          allocation: {
            phase: "held",
            reason: "allocation-conflict",
            issuedAt,
            conflictingSandboxes: ["bx_22222223", "bx_22222224"],
          },
        });
        const unverified = await seed({
          allocation: { phase: "held", reason: "lifetime-unverified", issuedAt },
          observation: created,
        });
        const stopped = await seed({ allocation: { phase: "held", reason: "run-stopped" } });
        // Stopped before create, its absence observed, and the worker died before ending it.
        const stoppedObserved = await seed({
          allocation: { phase: "held", reason: "run-stopped" },
          observation: { presence: "absent", basis: "not-discovered" },
        });
        const neverCreated = await seed({
          allocation: { phase: "deleted", removal: { kind: "never-created", completed: true } },
          observation: { presence: "absent", basis: "not-discovered" },
        });
        // Create refused under its key: issued, and Boat holds no VM.
        const refused = await seed({
          allocation: {
            phase: "deleted",
            issuedAt,
            removal: { kind: "never-created", completed: true },
          },
        });
        await upgrade();
        await upgraded(url, async ({ repo }) => {
          const read = carried(repo);
          expect(await read(reserved)).toMatchObject({
            vm: "reserved",
            launch: "none",
            run: { createIssuedAt: null, sandboxId: null, target: null },
          });
          expect(await read(issued)).toMatchObject({
            vm: "issued",
            run: { createIssuedAt: new Date(issuedAt), heldReason: null },
          });
          expect(await read(undated)).toMatchObject({
            vm: "issued",
            run: { createIssuedAt: undated.createdAt },
          });
          expect(await read(future)).toMatchObject({
            vm: "held",
            run: { createIssuedAt: future.createdAt, heldReason: "create-unresolved" },
          });
          expect(await read(allocated)).toMatchObject({
            vm: "allocated",
            launch: "none",
            run: { sandboxId: allocated.sandboxId, target: null, createdSeenAt: null },
          });
          expect(await read(unresolved)).toMatchObject({
            vm: "held",
            run: { heldReason: "create-unresolved", sandboxId: null },
          });
          expect(await read(conflict)).toMatchObject({
            vm: "held",
            run: {
              heldReason: "allocation-conflict",
              conflictingSandboxes: ["bx_22222223", "bx_22222224"],
            },
          });
          expect(await read(unverified)).toMatchObject({
            vm: "held",
            run: {
              heldReason: "lifetime-unverified",
              sandboxId: unverified.sandboxId,
              createdSeenAt: instant,
            },
          });
          expect(await read(stopped)).toMatchObject({
            vm: "held",
            run: { heldReason: "run-stopped", createIssuedAt: null, absentAt: null },
          });
          for (const never of [stoppedObserved, neverCreated])
            expect(await read(never)).toMatchObject({
              vm: "deleted",
              run: {
                absentBasis: "never-created",
                absentAt: never.observedAt,
                createIssuedAt: null,
                heldReason: null,
                sandboxId: null,
              },
            });
          expect(await read(refused)).toMatchObject({
            vm: "deleted",
            run: {
              absentBasis: "never-created",
              absentAt: instant,
              createIssuedAt: new Date(issuedAt),
            },
          });
          // The key's age is the database's reading of the carried issue time.
          expect(await Effect.runPromise(repo.createAgeMs(issued.runId))).toBeGreaterThan(
            7_000_000,
          );
          expect(await Effect.runPromise(repo.createAgeMs(reserved.runId))).toBeUndefined();
        });
      }));

    it("carries every deletion state: the claim, Boat's operation wherever it was recorded, and absence with what the VM held still held", () =>
      before(async ({ url, client, upgrade }, seed) => {
        const present = { presence: "present", basis: "read" } as const;
        const heldLaunch = { phase: "held", isolation: RECEIPTS } as const;
        const claimedAt = new Date(Date.now() - 10_000).toISOString();
        // The first DELETE claimed and nothing recorded of it.
        const claimed = await seed({
          allocation: {
            phase: "deleting",
            removal: { kind: "issued", token: randomUUID(), at: claimedAt },
          },
          execution: heldLaunch,
          observation: present,
          tunnel: {},
        });
        // Mid-deletion with Boat's operation on record.
        const deleting = await seed({
          allocation: {
            phase: "deleting",
            removal: { kind: "operation", id: OPERATION, completed: false },
          },
          execution: heldLaunch,
          observation: present,
          tunnel: {},
        });
        // The same for a VM never bound: no execution at all.
        const unbound = await seed({
          allocation: {
            phase: "deleting",
            removal: { kind: "operation", id: OPERATION, completed: false },
          },
          observation: { ...present, created: false },
        });
        // Mid-deletion as the earlier close recorded it: the operation on the tunnel row only.
        const legacy = await seed({
          allocation: { phase: "bound" },
          execution: heldLaunch,
          observation: present,
          tunnel: { removal: { id: OPERATION, completed: false } },
        });
        // That close's operation completed, and nothing released.
        const legacyCompleted = await seed({
          allocation: { phase: "bound" },
          execution: heldLaunch,
          observation: present,
          tunnel: { removal: { id: OPERATION, completed: true } },
        });
        // Boat's operation recorded complete and the worker died before anything else.
        const completed = await seed({
          allocation: {
            phase: "deleting",
            removal: { kind: "operation", id: OPERATION, completed: true },
          },
          execution: heldLaunch,
          observation: present,
          tunnel: {},
        });
        // Absent by Boat's own 404, with its port still reserved and its launch material kept.
        const gone = await seed({
          allocation: { phase: "bound" },
          execution: heldLaunch,
          observation: { presence: "absent", basis: "not-found" },
          tunnel: {},
        });
        // Ended and released: the operation completed, the absence observed, the slot released.
        const ended = await seed({
          allocation: {
            phase: "deleted",
            removal: { kind: "operation", id: OPERATION, completed: true },
          },
          execution: heldLaunch,
          observation: { presence: "absent", basis: "deletion-completed" },
          tunnel: { released: true },
        });
        // Ended on Boat's 404.
        const endedAbsent = await seed({
          allocation: { phase: "deleted", removal: { kind: "absent", completed: true } },
          execution: { phase: "aborted" },
          observation: { presence: "absent", basis: "not-found" },
        });
        await upgrade();
        await upgraded(url, async ({ repo, tunnels, executor }) => {
          const read = carried(repo);
          const slot = async (seeded: Seeded) =>
            (await Effect.runPromise(tunnels.get(seeded.runId)))?.released === true;
          expect(await read(claimed)).toMatchObject({
            vm: "deleting",
            launch: "held",
            run: {
              deletionClaimedAt: new Date(claimedAt),
              deletionOperationId: null,
              absentAt: null,
            },
          });
          for (const polled of [deleting, legacy])
            expect(await read(polled)).toMatchObject({
              vm: "deleting",
              launch: "held",
              run: {
                deletionOperationId: OPERATION,
                deletionCompletedAt: null,
                absentAt: null,
                sealedLaunch: polled.sealedEnvelope,
              },
            });
          // An operation on record is never claimed over: it is polled, and no second DELETE goes.
          expect(
            await Effect.runPromise(repo.claimDeletion(deleting.runId, 180_000)),
          ).toBeUndefined();
          expect(
            await Effect.runPromise(repo.claimDeletion(legacy.runId, 180_000)),
          ).toBeUndefined();
          expect(await read(unbound)).toMatchObject({
            vm: "deleting",
            launch: "aborted",
            run: { deletionOperationId: OPERATION, target: null, fencedAt: instant },
          });
          for (const done of [legacyCompleted, completed])
            expect(await read(done)).toMatchObject({
              vm: "deleted",
              run: {
                deletionOperationId: OPERATION,
                deletionCompletedAt: instant,
                absentAt: instant,
                absentBasis: "deletion-completed",
                sealedLaunch: null,
                sealedControl: done.sealedControl,
              },
            });
          expect(await read(gone)).toMatchObject({
            vm: "deleted",
            launch: "held",
            run: {
              absentAt: gone.observedAt,
              absentBasis: "not-found",
              createdSeenAt: instant,
              deletionOperationId: null,
              sealedLaunch: null,
            },
          });
          // Absent, and nothing it held was released by the migration: the sweep's cleanup does it.
          for (const unreleased of [legacyCompleted, completed, gone])
            expect(await slot(unreleased)).toBe(false);
          expect(await read(ended)).toMatchObject({
            vm: "deleted",
            run: {
              absentAt: ended.observedAt,
              absentBasis: "deletion-completed",
              deletionOperationId: OPERATION,
              deletionCompletedAt: instant,
            },
          });
          expect(await slot(ended)).toBe(true);
          expect(await read(endedAbsent)).toMatchObject({
            vm: "deleted",
            launch: "aborted",
            run: { absentBasis: "not-found", deletionOperationId: null },
          });
          // A bearer is checked at start only where Boat may still have the VM.
          const { unopened, checked } = await Effect.runPromise(
            verifyBoatBearers(DEPLOYMENT).pipe(
              Effect.provide(
                Layer.merge(
                  Layer.succeed(BoatRunRepo, repo),
                  Layer.succeed(BoatExecution, executor),
                ),
              ),
            ),
          );
          expect({ unopened, checked }).toEqual({ unopened: [], checked: 3 });
        });
        // The tunnel reservation is the run row's now.
        const { rows } = await client.query(
          `select confrelid::regclass::text as referenced from pg_constraint
          where conrelid = 'boat_tunnels'::regclass and contype = 'f'`,
        );
        expect(rows).toEqual([{ referenced: "boat_runs" }]);
      }));

    it("freezes the three old tables: every INSERT, UPDATE, DELETE and TRUNCATE raises, one that matches no row included, and they keep what they held", () =>
      before(async ({ client, upgrade }, seed) => {
        const run = await seed({
          allocation: { phase: "bound" },
          execution: { phase: "running", isolation: RECEIPTS },
          observation: { presence: "present", basis: "read" },
        });
        await upgrade();
        const frozen = /is frozen: Boat runs live in boat_runs/;
        for (const table of ["boat_allocations", "boat_executions", "boat_observations"]) {
          // What an older worker's compare-and-set does: an update that may match nothing.
          await expect(
            client.query(`update ${table} set deployment_id = deployment_id where false`),
          ).rejects.toThrow(frozen);
          await expect(
            client.query(
              `update ${table} set deployment_id = 'other' where runtime_instance_id = $1`,
              [run.runId],
            ),
          ).rejects.toThrow(frozen);
          await expect(
            client.query(`delete from ${table} where runtime_instance_id = $1`, [run.runId]),
          ).rejects.toThrow(frozen);
          await expect(
            client.query(`insert into ${table} select * from ${table} where false`),
          ).rejects.toThrow(frozen);
          await expect(client.query(`truncate ${table} cascade`)).rejects.toThrow(frozen);
          const { rows } = await client.query(
            `select deployment_id from ${table} where runtime_instance_id = $1`,
            [run.runId],
          );
          expect(rows).toEqual([{ deployment_id: DEPLOYMENT }]);
        }
      }));

    it("refuses an issue time in the future on boat_runs, by INSERT and by UPDATE", () =>
      before(async ({ client, upgrade }, seed) => {
        const run = await seed({ allocation: { phase: "reserved" } });
        await upgrade();
        const future = /create_issued_at of run .* is in the future/;
        await expect(
          client.query(
            `update boat_runs set create_issued_at = now() + interval '1 second' where run_id = $1`,
            [run.runId],
          ),
        ).rejects.toThrow(future);
        await expect(
          client.query(
            `insert into boat_runs (run_id, deployment_id, publication_id, workspace_id, launch_attempt_id, manifest_digest, snapshot_name, idempotency_key, disk_lineage, create_issued_at)
           select 'other-run', deployment_id, publication_id, workspace_id, launch_attempt_id, manifest_digest, snapshot_name, gen_random_uuid(), gen_random_uuid(), now() + interval '1 hour'
             from boat_runs where run_id = $1`,
            [run.runId],
          ),
        ).rejects.toThrow(future);
        // Issued by the statement's own now(): accepted.
        await client.query(`update boat_runs set create_issued_at = now() where run_id = $1`, [
          run.runId,
        ]);
        const { rows } = await client.query(
          `select create_issued_at <= now() as issued from boat_runs where run_id = $1`,
          [run.runId],
        );
        expect(rows).toEqual([{ issued: true }]);
      }));

    it("refuses to migrate an execution whose runtime instance is not its run, and leaves the old tables as they were (#561)", () =>
      before(async ({ client, upgrade }, seed) => {
        const run = await seed({
          allocation: { phase: "bound" },
          execution: { phase: "running", isolation: RECEIPTS },
        });
        if (run.target === null) throw new Error("missing target");
        const other = await seed({ allocation: { phase: "reserved" } });
        // The same execution under another runtime instance id: what #561 says nothing forbade.
        await client.query(`delete from boat_executions where runtime_instance_id = $1`, [
          run.runId,
        ]);
        await client.query(
          `insert into boat_executions (runtime_instance_id, run_id, deployment_id, sandbox_id, disk_lineage, record)
         values ($1, $2, $3, $4, $5, $6)`,
          [
            other.runId,
            run.runId,
            DEPLOYMENT,
            run.target.sandboxId,
            run.target.diskLineage,
            JSON.stringify({
              target: { ...run.target, runtimeInstanceId: other.runId },
              phase: "running",
            }),
          ],
        );
        await expect(refusal(upgrade())).resolves.toMatch(
          /boat_executions has 1 row\(s\) whose runtime_instance_id is not their run_id/,
        );
        // Nothing of the migration stayed: no table, no trigger, and the ledgers are writable.
        const { rows } = await client.query(`select to_regclass('boat_runs') as created`);
        expect(rows).toEqual([{ created: null }]);
        await client.query(`update boat_allocations set deployment_id = deployment_id`);
      }));

    it("refuses to migrate a sealed bearer that has no allocation to live on", () =>
      before(async ({ client, upgrade }, seed) => {
        const run = await seed({ allocation: { phase: "bound" }, execution: { phase: "control" } });
        // Its allocation bound to another boot: the bearer's seal would open under neither.
        await client.query(
          `update boat_allocations set record = jsonb_set(record, '{target,bootId}', to_jsonb($2::text))
          where runtime_instance_id = $1`,
          [run.runId, randomUUID()],
        );
        const refused = await refusal(upgrade());
        expect(refused).toMatch(
          /boat_executions has 1 row\(s\) with no allocation, or whose target is not their allocation's target/,
        );
        // It names the run to look at.
        expect(refused).toContain(run.runId);
        const { rows } = await client.query(`select to_regclass('boat_runs') as created`);
        expect(rows).toEqual([{ created: null }]);
      }));
  },
);
