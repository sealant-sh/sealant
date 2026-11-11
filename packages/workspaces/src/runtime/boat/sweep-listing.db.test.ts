import { randomUUID } from "node:crypto";

import { credentialCipherLayer } from "@sealant/credentials";
import {
  BoatRunRepo,
  BoatRunRepoLive,
  NativePublicationRepoLive,
  SealantDB,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRuntimeInstanceRepoLive,
  makeSealantDBLayer,
  schema,
  user,
  workspaceAttempts,
  type DB,
} from "@sealant/db";
import { boatRunSeedRows } from "@sealant/db/testing/boat-runs";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import { Effect, Layer, Logger } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";

import { BoatResourcesHost } from "../../worker/boat-resources.js";
import { GuestFixture } from "./allocation.fixture.js";
import { HttpBoatApi } from "./api.js";
import { BoatSecret } from "./config.js";
import {
  BOAT_KEPT_REPORT_MS,
  BoatConvergence,
  boatConvergenceLayerNoDeps,
  boatConvergenceObligations,
} from "./convergence.js";
import { BoatGuestTransportService, boatExecutionLayer } from "./execution.js";
import { boatKeptReports } from "./kept-report.js";
import { BoatAllocationProvider } from "./provider.js";
import { BoatRemoval } from "./removal.js";
import { BoatVm, boatAllocationObligations, boatVmLayerNoDeps } from "./vm.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
const execute = Effect.runPromise;
const DEPLOYMENT = "test";
const GATEWAY_HOST = randomUUID();
/** The worker's page: twenty runs a tick. */
const PAGE = 20;

type RunColumns = Partial<typeof schema.boatRuns.$inferInsert>;
type RuntimeStatus = (typeof schema.workspaceRuntimeInstances.$inferInsert)["status"];
/** One run as its tables hold it. Absent fields are rows the run does not have. */
interface Kind {
  /** Columns of the run's row, over a VM on record that is bound to its boot. */
  readonly run?: RunColumns;
  readonly pin?: "held" | "released";
  readonly tunnel?: "held" | "released";
  readonly runtime?: { readonly status: RuntimeStatus; readonly stop?: "user" };
  readonly capture?: "unended" | "gone";
  readonly deploymentId?: string;
}

const NO_VM = { sandboxId: null, createdSeenAt: null, target: null } satisfies RunColumns;
const RESERVED = { ...NO_VM, createIssuedAt: null } satisfies RunColumns;
const deletionId = () => `bdop_${randomUUID().replaceAll("-", "")}`;
/** Boat's own completed deletion: the absence an ended run usually has. */
const deleted = (): RunColumns => ({
  fencedAt: new Date(),
  deletionOperationId: deletionId(),
  deletionCompletedAt: new Date(),
  absentAt: new Date(),
  absentBasis: "deletion-completed",
});
const NEVER_CREATED = {
  ...RESERVED,
  absentAt: new Date(),
  absentBasis: "never-created",
} satisfies RunColumns;
/** A launch that was pushed and acknowledged: a daemon runs on the VM. */
const launched = (): RunColumns => ({
  exchangeId: randomUUID(),
  exchangePublicKey: "k".repeat(128),
  sealedControl: "sealed-control",
  admissionOperationId: randomUUID(),
  admissionEpoch: 1,
  admissionDigest: "d".repeat(64),
  docker: false,
  launchIssuedAt: new Date(),
  launchAcceptedAt: new Date(),
});
/** An ended run with nothing left: absent, its slot and pin released, its stop recorded. */
const SETTLED: Kind = {
  pin: "released",
  tunnel: "released",
  runtime: { status: "stopped", stop: "user" },
};
const settled = (): Kind => ({ ...SETTLED, run: deleted() });
const LIVE: Kind = { pin: "held", tunnel: "held", runtime: { status: "ready" } };

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
/** A VM id of Boat's own shape, one per seeded run. */
const sandboxId = (index: number) => {
  let rest = index;
  let id = "";
  for (let digit = 0; digit < 8; digit += 1) {
    id = `${ALPHABET.charAt(rest % ALPHABET.length)}${id}`;
    rest = Math.floor(rest / ALPHABET.length);
  }
  return `bx_${id}`;
};
/** Run ids in the order given: the sweeps page by run id. */
const runIdAt = (index: number) => `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;

/** Writes the runs straight to the tables, in the order given, and answers their ids. */
const seed = (db: DB, kinds: readonly Kind[], offset = 0) =>
  Effect.gen(function* () {
    if (kinds.length === 0) return [];
    const ownerUserId = `usr_${randomUUID()}`;
    yield* db
      .insert(user)
      .values({ id: ownerUserId, email: `${ownerUserId}@example.invalid`, name: "sweep test" });
    const rows = kinds.map((kind, position) => {
      const index = offset + position;
      const runId = runIdAt(index);
      const seeded = boatRunSeedRows({
        runId,
        sandboxId: sandboxId(index),
        deploymentId: kind.deploymentId ?? DEPLOYMENT,
      });
      return { kind, index, runId, seeded, run: { ...seeded.run, ...kind.run } };
    });
    yield* db.insert(workspaceAttempts).values(rows.map((row) => ({ id: row.runId, ownerUserId })));
    yield* db.insert(schema.nativePublications).values(rows.map((row) => row.seeded.publication));
    yield* db.insert(schema.boatRuns).values(rows.map((row) => row.run));
    const pins = rows.flatMap((row) =>
      row.kind.pin === undefined
        ? []
        : [
            {
              runId: row.runId,
              runtimeInstanceId: row.runId,
              publicationId: row.seeded.publication.id,
              state: row.kind.pin === "held" ? "live" : "released",
              releasedAt: row.kind.pin === "held" ? null : new Date(),
            },
          ],
    );
    if (pins.length > 0) yield* db.insert(schema.nativePublicationConsumers).values(pins);
    const tunnels = rows.flatMap((row) => {
      if (row.kind.tunnel === undefined) return [];
      const reservationId = randomUUID();
      // A held slot takes a port of its own; released ones may share one.
      const listenPort = row.kind.tunnel === "held" ? 61000 + (row.index % 512) : 61511;
      return [
        {
          runtimeInstanceId: row.runId,
          gatewayHostId: GATEWAY_HOST,
          listenPort,
          reservationId,
          record: {
            binding: { target: row.seeded.target, gatewayHostId: GATEWAY_HOST },
            reservationId,
            listenPort,
            material: null,
            ...(row.kind.tunnel === "released" ? { absent: true, released: true } : {}),
          },
          releasedAt: row.kind.tunnel === "released" ? new Date() : null,
        },
      ];
    });
    if (tunnels.length > 0) yield* db.insert(schema.boatTunnels).values(tunnels);
    const runtimes = rows.flatMap((row) =>
      row.kind.runtime === undefined
        ? []
        : [
            {
              runId: row.runId,
              adapter: "boat" as const,
              status: row.kind.runtime.status,
              stopReason: row.kind.runtime.stop ?? null,
              resourceId: row.run.sandboxId,
            },
          ],
    );
    if (runtimes.length > 0) yield* db.insert(schema.workspaceRuntimeInstances).values(runtimes);
    const captures = rows.flatMap((row) =>
      row.kind.capture === undefined
        ? []
        : [
            row.kind.capture === "gone"
              ? { runId: row.runId, state: "gone" as const }
              : { runId: row.runId, captureTokenSealed: "sealed-capture-token" },
          ],
    );
    if (captures.length > 0) yield* db.insert(schema.workspaceCaptureDrains).values(captures);
    return rows.map((row) => row.runId);
  });

/** Every line logged at warning level. */
const warnings = () => {
  const logged: string[] = [];
  const recorder = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn")
        logged.push(Array.isArray(message) ? message.join(" ") : String(message));
    }),
  ]);
  return { logged, recorder };
};

/**
 * Both sweeps over an owned database, with the real run store. Boat is never asked anything (its
 * API points at a closed port), and the removal only records which runs it was handed.
 */
const test = async (
  run: (context: {
    readonly db: DB;
    readonly repo: BoatRunRepo["Service"];
    readonly vm: BoatVm["Service"];
    readonly convergence: BoatConvergence["Service"];
    /** The runs the convergence sweep handed to the cleanup after absence. */
    readonly cleaned: string[];
  }) => Promise<void>,
) => {
  if (databaseUrl === undefined) throw new Error("SEALANT_TEST_DATABASE_URL required");
  await withWorkspaceJobTestDatabase(databaseUrl, async (url) => {
    const credential = BoatSecret.parse("test-provider-key-local-only");
    if (!credential.ok) throw credential.error;
    const api = HttpBoatApi.create({
      credential: credential.value,
      baseUrl: "http://127.0.0.1:9/api/v1",
      timeoutMs: 1000,
    });
    if (!api.ok) throw api.error;
    const cleaned: string[] = [];
    const Infra = Layer.mergeAll(
      makeSealantDBLayer(url),
      credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") }),
      Layer.succeed(BoatGuestTransportService, new GuestFixture()),
      Layer.succeed(BoatAllocationProvider, { deploymentId: DEPLOYMENT, api: api.value }),
      Layer.succeed(BoatResourcesHost, { deploymentId: DEPLOYMENT }),
      Layer.succeed(
        BoatRemoval,
        BoatRemoval.of({
          remove: () => Effect.succeed("removed" as const),
          cleanup: (given) =>
            Effect.sync(() => {
              cleaned.push(given.runId);
              return "removed" as const;
            }),
        }),
      ),
    );
    const Stores = Layer.mergeAll(
      BoatRunRepoLive,
      NativePublicationRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
      WorkspaceCaptureDrainRepoLive,
    );
    const Test = Layer.mergeAll(
      boatVmLayerNoDeps.pipe(Layer.provide(boatExecutionLayer)),
      boatConvergenceLayerNoDeps,
    ).pipe(Layer.provideMerge(Stores), Layer.provideMerge(Infra));
    await execute(
      Effect.gen(function* () {
        const db = yield* SealantDB;
        const repo = yield* BoatRunRepo;
        const vm = yield* BoatVm;
        const convergence = yield* BoatConvergence;
        yield* Effect.promise(() => run({ db, repo, vm, convergence, cleaned }));
      }).pipe(Effect.provide(Test)),
    );
  });
};
/** The shared stop is never reached by these rows: none is stopping with a VM. */
const stop = async () => "stopped" as const;

/**
 * Every kind of run, and whether each sweep's listing returns it. `unsettled`: the convergence
 * sweep's (something is left to settle). `unresolved`: the VM sweep's (its create is not resolved).
 */
const KINDS: readonly (Kind & {
  readonly name: string;
  readonly unsettled: boolean;
  readonly unresolved: boolean;
})[] = [
  // Not absent: Boat may hold a VM for it, whatever else is released.
  {
    name: "reserved: create not issued",
    run: RESERVED,
    pin: "held",
    runtime: { status: "pending" },
    unsettled: true,
    unresolved: true,
  },
  {
    name: "issued: create issued, no VM known",
    run: NO_VM,
    pin: "held",
    runtime: { status: "pending" },
    unsettled: true,
    unresolved: true,
  },
  {
    name: "held: stopped before its create",
    run: { ...RESERVED, heldReason: "run-stopped" },
    pin: "held",
    runtime: { status: "stopped", stop: "user" },
    unsettled: true,
    unresolved: true,
  },
  {
    name: "held: a create nobody can resolve",
    run: { ...NO_VM, heldReason: "create-unresolved" },
    pin: "held",
    runtime: { status: "failed" },
    unsettled: true,
    unresolved: true,
  },
  {
    name: "held: more than one VM carries its labels",
    run: {
      ...NO_VM,
      heldReason: "allocation-conflict",
      conflictingSandboxes: ["bx_23456789", "bx_6789abcd"],
    },
    pin: "held",
    runtime: { status: "failed" },
    unsettled: true,
    unresolved: true,
  },
  {
    name: "allocated: a VM, not bound",
    run: { target: null },
    pin: "held",
    runtime: { status: "pending" },
    unsettled: true,
    unresolved: false,
  },
  {
    name: "held: a VM whose lifetime cannot be verified",
    run: { target: null, heldReason: "lifetime-unverified" },
    pin: "held",
    runtime: { status: "failed" },
    unsettled: true,
    unresolved: false,
  },
  { name: "bound: a live session", ...LIVE, run: launched(), unsettled: true, unresolved: false },
  {
    name: "bound, launched without resources: no tunnel",
    run: { ...launched(), resources: "none" },
    pin: "held",
    runtime: { status: "ready" },
    unsettled: true,
    unresolved: false,
  },
  {
    name: "kept: stopping, its FINAL not confirmed, its VM still there",
    run: { ...launched(), fencedAt: new Date() },
    pin: "held",
    tunnel: "held",
    runtime: { status: "ready", stop: "user" },
    unsettled: true,
    unresolved: false,
  },
  {
    name: "kept: recorded stopped, its VM still there",
    run: launched(),
    pin: "held",
    tunnel: "held",
    runtime: { status: "stopped", stop: "user" },
    unsettled: true,
    unresolved: false,
  },
  {
    name: "deleting: the first DELETE is claimed",
    run: { fencedAt: new Date(), deletionClaimedAt: new Date() },
    pin: "held",
    tunnel: "held",
    runtime: { status: "ready", stop: "user" },
    unsettled: true,
    unresolved: false,
  },
  {
    name: "deleting: Boat's deletion operation is on record, not complete",
    run: { fencedAt: new Date(), deletionOperationId: deletionId() },
    pin: "held",
    tunnel: "held",
    runtime: { status: "ready", stop: "user" },
    unsettled: true,
    unresolved: false,
  },
  // Absent, and something it held is not released.
  {
    name: "absent, its tunnel slot and its pin held",
    ...SETTLED,
    run: deleted(),
    pin: "held",
    tunnel: "held",
    unsettled: true,
    unresolved: false,
  },
  {
    name: "absent, its tunnel slot held",
    ...SETTLED,
    run: deleted(),
    tunnel: "held",
    unsettled: true,
    unresolved: false,
  },
  {
    name: "absent, its pin held",
    ...SETTLED,
    run: deleted(),
    pin: "held",
    unsettled: true,
    unresolved: false,
  },
  {
    name: "absent by Boat's 404, its pin held, no tunnel",
    run: { absentAt: new Date(), absentBasis: "not-found" },
    pin: "held",
    runtime: { status: "stopped", stop: "user" },
    unsettled: true,
    unresolved: false,
  },
  {
    name: "never created, its pin held",
    run: NEVER_CREATED,
    pin: "held",
    runtime: { status: "stopped", stop: "user" },
    unsettled: true,
    unresolved: false,
  },
  // Absent and released, and a record of its end is not written.
  {
    name: "absent and released, its stop requested and not recorded",
    ...SETTLED,
    run: deleted(),
    runtime: { status: "ready", stop: "user" },
    unsettled: true,
    unresolved: false,
  },
  {
    name: "absent and released, its launch failed and not recorded stopped",
    ...SETTLED,
    run: deleted(),
    runtime: { status: "failed" },
    unsettled: true,
    unresolved: false,
  },
  {
    name: "never created and released, its capture record not ended",
    run: NEVER_CREATED,
    pin: "released",
    runtime: { status: "stopped", stop: "user" },
    capture: "unended",
    unsettled: true,
    unresolved: false,
  },
  // Settled.
  {
    name: "absent and fully released",
    ...SETTLED,
    run: deleted(),
    unsettled: false,
    unresolved: false,
  },
  {
    name: "absent and released, a run that never had a tunnel",
    run: { ...deleted(), resources: "none" },
    pin: "released",
    runtime: { status: "stopped", stop: "user" },
    unsettled: false,
    unresolved: false,
  },
  {
    name: "absent by Boat's 404 and fully released",
    ...SETTLED,
    run: { absentAt: new Date(), absentBasis: "not-found" },
    unsettled: false,
    unresolved: false,
  },
  {
    name: "never created and released, its capture record ended",
    run: NEVER_CREATED,
    pin: "released",
    runtime: { status: "stopped", stop: "user" },
    capture: "gone",
    unsettled: false,
    unresolved: false,
  },
  {
    name: "never created and released, no capture record",
    run: NEVER_CREATED,
    pin: "released",
    runtime: { status: "stopped", stop: "user" },
    unsettled: false,
    unresolved: false,
  },
  {
    // The capture record of a VM that existed is the shared stop's and the exit reconciler's.
    name: "absent and fully released, a VM's capture record not ended",
    ...SETTLED,
    run: deleted(),
    capture: "unended",
    unsettled: false,
    unresolved: false,
  },
  {
    // Still recorded live: the exit reconciler records what became of it; this sweep does nothing.
    name: "absent and released, still recorded ready with no stop",
    ...SETTLED,
    run: deleted(),
    runtime: { status: "ready" },
    unsettled: false,
    unresolved: false,
  },
  {
    name: "another deployment's live session",
    ...LIVE,
    deploymentId: "another",
    unsettled: false,
    unresolved: false,
  },
  {
    name: "another deployment's unresolved create",
    run: NO_VM,
    pin: "held",
    deploymentId: "another",
    unsettled: false,
    unresolved: false,
  },
];

describe.runIf(databaseUrl !== undefined)("Boat sweep listings", () => {
  it("return a run exactly while something of it is left to do, for every kind of run", () =>
    test(async ({ db, repo }) => {
      const ids = await execute(seed(db, KINDS));
      const named = new Map(ids.map((id, index) => [id, KINDS[index]?.name]));
      const names = (listed: readonly string[]) => listed.map((id) => named.get(id));
      const page = { deploymentId: DEPLOYMENT, limit: 100 };
      expect(names(await execute(repo.listUnsettled(page)))).toEqual(
        KINDS.filter((kind) => kind.unsettled).map((kind) => kind.name),
      );
      expect(names(await execute(repo.listUnresolved(page)))).toEqual(
        KINDS.filter((kind) => kind.unresolved).map((kind) => kind.name),
      );
      // Every run is still in the plain listing: only the sweeps' pages are narrowed.
      expect(await execute(repo.list(page))).toEqual(
        ids.filter((_, index) => KINDS[index]?.deploymentId === undefined),
      );
    }));

  it("page in run order with the cursor, each run once, whatever the page size", () =>
    test(async ({ db, repo }) => {
      await execute(seed(db, KINDS));
      for (const list of [repo.listUnsettled, repo.listUnresolved]) {
        const whole = await execute(list({ deploymentId: DEPLOYMENT, limit: 100 }));
        expect(whole).toEqual(whole.toSorted());
        for (const limit of [1, 3, 7]) {
          const paged: string[] = [];
          for (;;) {
            const after = paged.at(-1);
            const next = await execute(
              list({ deploymentId: DEPLOYMENT, limit, ...(after === undefined ? {} : { after }) }),
            );
            paged.push(...next);
            if (next.length < limit) break;
          }
          expect(paged, `limit ${String(limit)}`).toEqual(whole);
        }
        for (const limit of [0, 101, 1.5])
          await expect(execute(list({ deploymentId: DEPLOYMENT, limit }))).rejects.toThrow(
            "invalid-record",
          );
      }
    }));
});

describe.runIf(databaseUrl !== undefined)("Boat sweeps over a deployment's history", () => {
  it("reach a run with something left to do in one tick, behind several pages of ended runs", () =>
    test(async ({ db, vm, convergence, cleaned }) => {
      // Five pages of ended runs, then one whose pin is still held and one stopped before create.
      const ended = await execute(seed(db, Array.from({ length: 5 * PAGE }, settled)));
      const [pinned, stopped] = await execute(
        seed(
          db,
          [
            { ...SETTLED, run: deleted(), pin: "held" },
            { run: RESERVED, pin: "held", runtime: { status: "stopped", stop: "user" } },
          ],
          ended.length,
        ),
      );
      if (pinned === undefined || stopped === undefined) throw new Error("missing runs");
      expect(ended.every((id) => id < pinned && id < stopped)).toBe(true);

      // The worker's first tick: no cursor, twenty runs.
      expect(await execute(vm.reconcile({ limit: PAGE }))).toEqual({
        entries: [{ runId: stopped, outcome: "held", held: "run-stopped" }],
      });
      expect(await execute(convergence.reconcile({ limit: PAGE, stop }))).toEqual({
        entries: [
          { runId: pinned, outcome: "cleaned" },
          // Held by the VM sweep just above: recorded never created, and cleaned up.
          { runId: stopped, outcome: "cleaned" },
        ],
      });
      expect(cleaned.toSorted()).toEqual([pinned, stopped]);
    }));

  it("visit every run with something left to do within ceil(count / page) ticks", () =>
    test(async ({ db, vm, convergence }) => {
      // Forty-five live sessions and forty-five conflicts, which stay as they are, among nine
      // hundred ended runs: one in ten runs of each sweep's order is its own.
      const total = 990;
      const kinds = Array.from({ length: total }, (_, index): Kind => {
        if (index % 22 === 5) return { ...LIVE, run: launched() };
        if (index % 22 === 16)
          return {
            run: {
              ...NO_VM,
              heldReason: "allocation-conflict",
              conflictingSandboxes: ["bx_23456789", "bx_6789abcd"],
            },
            pin: "held",
            runtime: { status: "failed" },
          };
        return settled();
      });
      const ids = await execute(seed(db, kinds));
      const live = ids.filter((_, index) => index % 22 === 5);
      const conflicts = ids.filter((_, index) => index % 22 === 16);
      expect(live).toHaveLength(45);
      expect(conflicts).toHaveLength(45);

      // The worker's loop: each sweep keeps its own cursor and wraps when a page is short.
      const ticks = Math.ceil(45 / PAGE);
      const resolved: string[] = [];
      const converged: string[] = [];
      let vmCursor: string | undefined;
      let convergenceCursor: string | undefined;
      for (let tick = 0; tick < ticks; tick += 1) {
        const swept = await execute(
          vm.reconcile({ limit: PAGE, ...(vmCursor === undefined ? {} : { after: vmCursor }) }),
        );
        vmCursor = swept.next;
        resolved.push(...swept.entries.map((entry) => entry.runId));
        const settling = await execute(
          convergence.reconcile({
            limit: PAGE,
            ...(convergenceCursor === undefined ? {} : { after: convergenceCursor }),
            stop,
          }),
        );
        convergenceCursor = settling.next;
        converged.push(...settling.entries.map((entry) => entry.runId));
      }
      // The VM sweep's own are the conflicts; the convergence sweep's are both, in run order.
      expect(resolved).toEqual(conflicts);
      expect(converged.slice(0, 2 * PAGE + 5)).toEqual(
        [...live, ...conflicts].toSorted().slice(0, 2 * PAGE + 5),
      );
      // Ninety unsettled runs: every one within ceil(90 / 20) ticks, and nothing else in a page.
      const all = new Set(converged);
      for (let tick = ticks; tick < Math.ceil(90 / PAGE); tick += 1) {
        const settling = await execute(
          convergence.reconcile({
            limit: PAGE,
            ...(convergenceCursor === undefined ? {} : { after: convergenceCursor }),
            stop,
          }),
        );
        convergenceCursor = settling.next;
        for (const entry of settling.entries) all.add(entry.runId);
      }
      expect([...all].toSorted()).toEqual([...live, ...conflicts].toSorted());
      // The page after the last one is short, so the cursor wraps to the first run again.
      expect(convergenceCursor).toBeUndefined();
    }));
});

describe.runIf(databaseUrl !== undefined)("Boat sweep reports", () => {
  it("say a conflict on every tick, a run held as it is once an hour, and never a launch in progress", () =>
    test(async ({ db, vm }) => {
      const [launching, conflict, stopped] = await execute(
        seed(db, [
          // Reserved and active: its launch has not issued create yet.
          { run: RESERVED, pin: "held", runtime: { status: "pending" } },
          {
            run: {
              ...NO_VM,
              heldReason: "allocation-conflict",
              conflictingSandboxes: ["bx_23456789", "bx_6789abcd"],
            },
            pin: "held",
            runtime: { status: "failed" },
          },
          { run: RESERVED, pin: "held", runtime: { status: "stopped", stop: "user" } },
        ]),
      );
      if (launching === undefined || conflict === undefined || stopped === undefined)
        throw new Error("missing runs");
      const due = boatKeptReports();
      /** What the worker would warn of at this tick. */
      const reported = async (at: number) => {
        const swept = await execute(vm.reconcile({ limit: PAGE }));
        expect(swept.entries).toEqual([
          { runId: launching, outcome: "pending" },
          { runId: conflict, outcome: "held", held: "allocation-conflict" },
          { runId: stopped, outcome: "held", held: "run-stopped" },
        ]);
        return boatAllocationObligations(swept.entries, (runId) => due(runId, at)).map(
          (entry) => entry.runId,
        );
      };
      const start = Date.now();
      // First met: both held runs are said. The launch in progress never is.
      expect(await reported(start)).toEqual([conflict, stopped]);
      // Every tick after it for an hour: only the conflict, which an operator has to look at.
      for (let tick = 1; tick <= 3; tick += 1)
        expect(await reported(start + tick * 30_000)).toEqual([conflict]);
      expect(await reported(start + BOAT_KEPT_REPORT_MS - 1)).toEqual([conflict]);
      expect(await reported(start + BOAT_KEPT_REPORT_MS)).toEqual([conflict, stopped]);
      expect(await reported(start + BOAT_KEPT_REPORT_MS + 30_000)).toEqual([conflict]);
    }));

  it("say a create nobody can resolve once an hour, though the sweep visits it on every tick", () =>
    test(async ({ db, convergence }) => {
      const [unresolved] = await execute(
        seed(db, [
          {
            run: { ...NO_VM, heldReason: "create-unresolved" },
            pin: "held",
            runtime: { status: "failed" },
          },
        ]),
      );
      if (unresolved === undefined) throw new Error("missing run");
      const { logged, recorder } = warnings();
      const due = boatKeptReports();
      const said = () => logged.filter((line) => line.includes("held for an operator")).length;
      const pass = async (at: number) => {
        const swept = await execute(
          Effect.gen(function* () {
            yield* TestClock.setTime(at);
            return yield* convergence.reconcile({ limit: PAGE, stop });
          }).pipe(Effect.provide(recorder), Effect.provide(TestClock.layer())),
        );
        expect(swept.entries).toEqual([{ runId: unresolved, outcome: "held" }]);
        return boatConvergenceObligations(swept.entries, (runId) => due(runId, at));
      };
      const start = Date.now();
      // Twenty ticks over ten minutes: visited on each, said once, listed once.
      expect(await pass(start)).toEqual([{ runId: unresolved, outcome: "held" }]);
      for (let tick = 1; tick < 20; tick += 1)
        expect(await pass(start + tick * 30_000)).toEqual([]);
      expect(said()).toBe(1);
      expect(logged.find((line) => line.includes("held for an operator"))).toContain(unresolved);
      // An hour on: said and listed again.
      expect(await pass(start + BOAT_KEPT_REPORT_MS)).toEqual([
        { runId: unresolved, outcome: "held" },
      ]);
      expect(said()).toBe(2);
    }));
});
