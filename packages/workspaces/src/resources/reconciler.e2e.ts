/**
 * The resource reconciler against a real Docker daemon and a real, migrated Postgres: the executor
 * hooks the Docker adapter calls on launch and removal, and the worker's tick. Stand-in executors
 * are busybox containers whose runs are recorded as a workspace's, as the worker records them.
 *
 * Run: `SEALANT_TEST_DATABASE_URL=… pnpm --filter @sealant/workspaces test:e2e src/resources/reconciler.e2e.ts`.
 * It skips without the database. The tick reads every domain, so it runs in a database of its own,
 * made from that one and dropped after. It removes exactly the containers, networks and volumes it
 * made.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { ResourceInstanceKey, ResourceWorktreeKey } from "@sealant/api-contracts";
import {
  createSealantDB,
  parseSubnetPool,
  ResourceDomainRepo,
  ResourceDomainRepoLive,
  ResourceInstanceRepo,
  ResourceInstanceRepoLive,
  schema,
  SealantDB,
  user,
  type DB,
  type ResourceInstanceRecord,
  type ResourceInstanceRepoService,
} from "@sealant/db";
import { runMigrations } from "@sealant/db/migrate";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  egressNetworkName,
  instanceContainerName,
  instanceVolumeName,
  reachNetworkName,
} from "./docker-resource-argv.js";
import { DockerResourceRuntime } from "./docker-resource-runtime.js";
import { makeResourceReconciler, type ResourceReconciler } from "./reconciler.js";
import { postgresSpec } from "./resource.fixture.js";
import { repositorySubnets } from "./subnets.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
const execFileAsync = promisify(execFile);
const docker = async (...args: string[]) =>
  (await execFileAsync("docker", args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const succeeds = (...args: string[]) =>
  docker(...args).then(
    () => true,
    () => false,
  );
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const POSTGRES =
  "postgres:18-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5";
const BUSYBOX =
  "busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
const tag = `core-res-tick-${String(process.pid)}`;
const migrationsFolder = join(
  dirname(createRequire(import.meta.url).resolve("@sealant/db/migrate")),
  "..",
  "drizzle",
);

describe.skipIf(DATABASE_URL === undefined)("the resource reconciler", () => {
  const databaseName = `sealant_resource_tick_${randomUUID().replaceAll("-", "")}`;
  const admin = new URL(DATABASE_URL ?? "postgresql://unused");
  const fresh = new URL(admin);
  fresh.pathname = `/${databaseName}`;
  let adminDb: DB;
  let db: DB;
  let repo: ResourceInstanceRepoService;
  let reconciler: ResourceReconciler;
  let domainId: string;
  let instance: ResourceInstanceRecord;
  const person = `user_${tag}_${randomUUID()}`;
  const workspaceId = `ws_${tag}_${randomUUID()}`;
  const executors = { first: `${tag}-e1`, replacement: `${tag}-e2` } as const;
  const runs = { first: `run_${randomUUID()}`, replacement: `run_${randomUUID()}` } as const;
  const created = { containers: new Set<string>(), networks: new Set<string>() };

  const run = <A, E>(effect: Effect.Effect<A, E, ResourceInstanceRepo | ResourceDomainRepo>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(ResourceInstanceRepoLive, ResourceDomainRepoLive).pipe(
            Layer.provide(Layer.succeed(SealantDB, db)),
          ),
        ),
      ),
    );
  const current = async () => {
    const read = await Effect.runPromise(repo.get(domainId, ResourceInstanceKey.make("db")));
    if (read === undefined) throw new Error("the instance should exist");
    return read;
  };
  const psql = async (sql: string) =>
    docker("exec", "-u", "postgres", instanceContainerName(instance.id), "psql", "-tAc", sql);

  /** A busybox executor on a network of its own, recorded as the workspace's run, ready. */
  const launchExecutor = async (runId: string, executor: string) => {
    const network = `${executor}-net`;
    await docker("network", "create", "--label", `core-res-test=${tag}`, network);
    created.networks.add(network);
    await docker(
      "run",
      "-d",
      "--name",
      executor,
      "--label",
      `core-res-test=${tag}`,
      "--network",
      network,
      BUSYBOX,
      "httpd",
      "-f",
      "-p",
      "8080",
    );
    created.containers.add(executor);
    created.networks.add(reachNetworkName(executor));
    await Effect.runPromise(
      db.insert(schema.workspaceAttempts).values({ id: runId, ownerUserId: person }),
    );
    await Effect.runPromise(db.insert(schema.workspaceRunLinks).values({ workspaceId, runId }));
    await Effect.runPromise(
      db
        .insert(schema.workspaceRuntimeInstances)
        .values({ runId, adapter: "docker", status: "ready", reference: executor }),
    );
  };
  /** The run's executor ended, as the worker records a stop. */
  const endRun = (runId: string) =>
    Effect.runPromise(
      db.execute(
        `UPDATE workspace_runtime_instances SET status = 'stopped', finished_at = now() WHERE run_id = '${runId}'`,
      ),
    );

  beforeAll(async () => {
    adminDb = await createSealantDB(admin.toString());
    await Effect.runPromise(adminDb.execute(`CREATE DATABASE "${databaseName}"`));
    await runMigrations({ databaseUrl: fresh.toString(), migrationsFolder, log: () => {} });
    db = await createSealantDB(fresh.toString());
    repo = await run(ResourceInstanceRepo);
    const third = 16 * Math.floor(Math.random() * 15);
    const runtime = new DockerResourceRuntime({
      subnets: repositorySubnets(repo, {
        reach: parseSubnetPool(`10.246.${String(third)}.0/20`, 27),
        egress: parseSubnetPool(`10.245.${String(third)}.0/20`, 28),
      }),
      readyTimeoutMs: 90_000,
    });
    reconciler = makeResourceReconciler({ repo, runtime });
    await Effect.runPromise(
      db.insert(user).values({ id: person, name: "tick", email: `${person}@example.test` }),
    );
    await Effect.runPromise(
      db.insert(schema.workspaces).values({ id: workspaceId, ownerUserId: person }),
    );
    domainId = await run(
      Effect.flatMap(ResourceDomainRepo, (domains) =>
        Effect.map(domains.ensure(`test:${tag}:${randomUUID()}`), (ensured) => ensured.domain.id),
      ),
    );
    const outcome = await Effect.runPromise(
      repo.up({
        resourceDomainId: domainId,
        key: ResourceInstanceKey.make("db"),
        spec: postgresSpec({
          image: POSTGRES,
          volumes: [{ name: "data", mountPath: "/var/lib/postgresql" }],
          env: { POSTGRES_HOST_AUTH_METHOD: "trust" },
          idleStopAfterSeconds: 5,
        }),
        cause: "use",
      }),
    );
    if (outcome.kind !== "upserted") throw new Error("the instance should be written");
    instance = outcome.instance;
    created.containers.add(instanceContainerName(instance.id));
    created.networks.add(egressNetworkName(instance.id));
    await Effect.runPromise(
      repo.link({
        workspaceId,
        resourceDomainId: domainId,
        worktreeKey: ResourceWorktreeKey.make("w1"),
        aliases: null,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await docker("rm", "-f", ...created.containers).catch(() => undefined);
    for (const network of created.networks) {
      await docker("network", "rm", network).catch(() => undefined);
    }
    await docker("volume", "rm", instanceVolumeName(instance.id, "data")).catch(() => undefined);
    await Effect.runPromise(
      adminDb.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`),
    );
  }, 120_000);

  it("starts an instance its row asks to run, at the first tick", async () => {
    const report = await reconciler.tick();
    expect(report.restarted).toEqual(["db"]);
    expect(report.problems).toEqual([]);
    expect((await current()).observed.kind).toBe("running");
    await psql("create table kept (v text); insert into kept values ('row-1')");
  }, 180_000);

  it("attaches a launched executor, and gives its replacement a new network while the old one goes", async () => {
    await launchExecutor(runs.first, executors.first);
    await reconciler.hooks.launched({ runId: runs.first, executor: executors.first });
    expect(await succeeds("exec", executors.first, "nc", "-z", "-w", "3", "db", "5432")).toBe(true);

    // The replacement, as the worker runs one: the old executor ends and is removed, a new run launches.
    await endRun(runs.first);
    await docker("rm", "-f", executors.first);
    await reconciler.hooks.removed(executors.first);
    await launchExecutor(runs.replacement, executors.replacement);
    await reconciler.hooks.launched({ runId: runs.replacement, executor: executors.replacement });

    expect(await succeeds("exec", executors.replacement, "nc", "-z", "-w", "3", "db", "5432")).toBe(
      true,
    );
    expect(await succeeds("network", "inspect", reachNetworkName(executors.first))).toBe(false);
    expect(
      (await Effect.runPromise(repo.networks("reach"))).map((network) => network.owner),
    ).not.toContain(executors.first);
    const report = await reconciler.tick();
    expect(report.problems).toEqual([]);
    expect(report.reached).toBe(1);
  }, 180_000);

  it("runs a killed instance again within one tick, with the metadata guard back in", async () => {
    await docker("kill", instanceContainerName(instance.id));
    const report = await reconciler.tick();
    expect(report.restarted).toEqual(["db"]);
    expect(report.problems).toEqual([]);
    expect(
      await docker("inspect", "--format", "{{.State.Running}}", instanceContainerName(instance.id)),
    ).toBe("true");
    expect(await docker("exec", instanceContainerName(instance.id), "ip", "route")).toMatch(
      /prohibit 169\.254\.169\.254/,
    );
    expect(await succeeds("exec", executors.replacement, "nc", "-z", "-w", "3", "db", "5432")).toBe(
      true,
    );
    expect(await psql("select v from kept")).toBe("row-1");
  }, 180_000);

  it("stops an instance no live executor reached for its idle time, and keeps its data", async () => {
    await endRun(runs.replacement);
    await delay(6000);
    const report = await reconciler.tick();
    expect(report.idleStopped).toEqual(["db"]);
    expect(report.problems).toEqual([]);
    const stopped = await current();
    expect(stopped).toMatchObject({ desired: "stopped", stopReason: { kind: "idle" } });
    expect(stopped.observed).toMatchObject({ kind: "stopped", reason: { kind: "idle" } });
    expect(
      await docker("inspect", "--format", "{{.State.Running}}", instanceContainerName(instance.id)),
    ).toBe("false");
    expect(await succeeds("volume", "inspect", instanceVolumeName(instance.id, "data"))).toBe(true);
    // The executor that ended took its reach network with it at this tick.
    expect(await succeeds("network", "inspect", reachNetworkName(executors.replacement))).toBe(
      false,
    );

    await Effect.runPromise(
      repo.up({
        resourceDomainId: domainId,
        key: ResourceInstanceKey.make("db"),
        spec: instance.spec,
        cause: "use",
      }),
    );
    const again = await reconciler.tick();
    expect(again).toMatchObject({ restarted: ["db"], problems: [] });
    expect((await current()).observed).toMatchObject({ kind: "running" });
    expect(await psql("select v from kept")).toBe("row-1");
  }, 180_000);
});
