/**
 * Resource instances, workspace links and network subnets against real Postgres. Gated on
 * SEALANT_TEST_DATABASE_URL (a disposable, migrated database).
 */
import { randomUUID } from "node:crypto";

import {
  ResourceInstanceKey,
  ResourceReachAliases,
  ResourceWorktreeKey,
  resourceInstanceSpecSchema,
  type ResourceInstanceSpec,
} from "@sealant/api-contracts";
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
  type ResourceInstanceRepoService,
} from "@sealant/db";
import { Effect, Layer, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const spec = (overrides: Partial<Record<keyof ResourceInstanceSpec, unknown>> = {}) =>
  Schema.decodeUnknownSync(resourceInstanceSpecSchema)({
    alias: "db",
    worktreeKey: null,
    image: `postgres:18@sha256:${"a".repeat(64)}`,
    command: null,
    env: { POSTGRES_HOST_AUTH_METHOD: "trust" },
    volumes: [{ name: "data", mountPath: "/var/lib/postgresql" }],
    limits: { cpuMillicores: 1000, memoryBytes: 512 * 1024 * 1024 },
    ready: { kind: "tcp", port: 5432 },
    idleStopAfterSeconds: 1800,
    ...overrides,
  });

const key = (value: string) => ResourceInstanceKey.make(value);
const worktree = (value: string) => ResourceWorktreeKey.make(value);

describe.skipIf(DATABASE_URL === undefined)("resource instances (Postgres)", () => {
  let db: DB;
  const person = `user_instances_${randomUUID()}`;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      db.insert(user).values({ id: person, name: "instances", email: `${person}@example.test` }),
    );
  });

  const run = <A, E>(
    use: (
      repo: ResourceInstanceRepoService,
      domains: typeof ResourceDomainRepo.Service,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.flatMap(Effect.all([ResourceInstanceRepo, ResourceDomainRepo]), ([repo, domains]) =>
        use(repo, domains),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(ResourceInstanceRepoLive, ResourceDomainRepoLive).pipe(
            Layer.provide(Layer.succeed(SealantDB, db)),
          ),
        ),
      ),
    );

  const newDomain = () =>
    run((_, domains) =>
      Effect.map(domains.ensure(`test:${randomUUID()}`), (ensured) => ensured.domain.id),
    );

  /** A workspace with one run whose Docker executor is `executor`, in `status`. */
  const workspaceWithExecutor = async (
    executor: string,
    status: "pending" | "ready" | "stopped",
  ) => {
    const workspaceId = `ws_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(schema.workspaceAttempts).values({ id: runId, ownerUserId: person }),
    );
    await Effect.runPromise(
      db.insert(schema.workspaces).values({ id: workspaceId, ownerUserId: person }),
    );
    await Effect.runPromise(db.insert(schema.workspaceRunLinks).values({ workspaceId, runId }));
    await Effect.runPromise(
      db.insert(schema.workspaceRuntimeInstances).values({
        runId,
        adapter: "docker",
        status,
        reference: executor,
        ...(status === "stopped" ? { finishedAt: new Date() } : {}),
      }),
    );
    return { workspaceId, runId };
  };

  it("answers one instance to the same spec twice, and updates its digest when the spec changes", async () => {
    const domain = await newDomain();
    const [first, second, changed] = await run((repo) =>
      Effect.all([
        repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "use" }),
        repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "use" }),
        repo.up({
          resourceDomainId: domain,
          key: key("db"),
          spec: spec({ env: {} }),
          cause: "use",
        }),
      ]),
    );
    expect(first.kind).toBe("upserted");
    if (first.kind !== "upserted" || second.kind !== "upserted" || changed.kind !== "upserted") {
      throw new Error("every up should write");
    }
    expect(second.instance.id).toBe(first.instance.id);
    expect(second.instance.specDigest).toBe(first.instance.specDigest);
    expect(changed.instance.id).toBe(first.instance.id);
    expect(changed.instance.specDigest).not.toBe(first.instance.specDigest);
    expect(changed.instance.desired).toBe("running");
    expect(await run((repo) => repo.list(domain, { archived: false }))).toHaveLength(1);
  });

  it("keeps a person's stop against use, and a person's start clears it", async () => {
    const domain = await newDomain();
    const outcome = await run((repo) =>
      repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "use" }),
    );
    if (outcome.kind !== "upserted") throw new Error("up should write");
    const id = outcome.instance.id;
    await run((repo) =>
      repo.setDesired(id, { kind: "stop", reason: { kind: "person", by: "Maria" } }),
    );
    const used = await run((repo) =>
      repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "use" }),
    );
    expect(used.kind === "upserted" && used.instance.desired).toBe("stopped");
    expect(used.kind === "upserted" && used.instance.stopReason).toEqual({
      kind: "person",
      by: "Maria",
    });
    const started = await run((repo) =>
      repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "person" }),
    );
    expect(started.kind === "upserted" && started.instance.desired).toBe("running");
    expect(started.kind === "upserted" && started.instance.stopReason).toBeNull();
  });

  it("starts an idle-stopped instance on use", async () => {
    const domain = await newDomain();
    const outcome = await run((repo) =>
      repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "use" }),
    );
    if (outcome.kind !== "upserted") throw new Error("up should write");
    await run((repo) =>
      repo.setDesired(outcome.instance.id, { kind: "stop", reason: { kind: "idle" } }),
    );
    const used = await run((repo) =>
      repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "use" }),
    );
    expect(used.kind === "upserted" && used.instance.desired).toBe("running");
  });

  it("leaves an archived instance archived, and frees its alias", async () => {
    const domain = await newDomain();
    const outcome = await run((repo) =>
      repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "use" }),
    );
    if (outcome.kind !== "upserted") throw new Error("up should write");
    await run((repo) => repo.setDesired(outcome.instance.id, { kind: "archive" }));
    const again = await run((repo) =>
      repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "person" }),
    );
    expect(again.kind).toBe("archived");
    const restarted = await run((repo) => repo.setDesired(outcome.instance.id, { kind: "run" }));
    expect(restarted?.desired).toBe("archived");
    const other = await run((repo) =>
      repo.up({ resourceDomainId: domain, key: key("db-2"), spec: spec(), cause: "use" }),
    );
    expect(other.kind).toBe("upserted");
    expect(await run((repo) => repo.list(domain, { archived: true }))).toHaveLength(1);
  });

  it("refuses a second live instance with the same alias for the same worktree key", async () => {
    const domain = await newDomain();
    const outcomes = await run((repo) =>
      Effect.all([
        repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "use" }),
        repo.up({ resourceDomainId: domain, key: key("db-copy"), spec: spec(), cause: "use" }),
        repo.up({
          resourceDomainId: domain,
          key: key("db@w1"),
          spec: spec({ worktreeKey: "w1" }),
          cause: "use",
        }),
      ]),
    );
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "upserted",
      "alias-taken",
      "upserted",
    ]);
  });

  it("refuses up on a domain that is not active", async () => {
    const domain = await newDomain();
    await run((repo) => repo.setDomainState(domain, "fenced"));
    const outcome = await run((repo) =>
      repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "use" }),
    );
    expect(outcome).toEqual({ kind: "domain-not-active", state: "fenced" });
  });

  it("links a workspace once, moves its worktree key and map, and refuses a second domain", async () => {
    const domain = await newDomain();
    const otherDomain = await newDomain();
    const { workspaceId } = await workspaceWithExecutor(`sealant-${randomUUID()}`, "ready");
    const aliases = Schema.decodeUnknownSync(ResourceReachAliases)({ mail: "worktree" });
    const [first, again, moved, mapped, cleared, other, missing] = await run((repo) =>
      Effect.all([
        repo.link({
          workspaceId,
          resourceDomainId: domain,
          worktreeKey: worktree("w1"),
          aliases: null,
        }),
        repo.link({
          workspaceId,
          resourceDomainId: domain,
          worktreeKey: worktree("w1"),
          aliases: null,
        }),
        repo.link({
          workspaceId,
          resourceDomainId: domain,
          worktreeKey: worktree("w2"),
          aliases: null,
        }),
        repo.link({ workspaceId, resourceDomainId: domain, worktreeKey: worktree("w2"), aliases }),
        repo.link({
          workspaceId,
          resourceDomainId: domain,
          worktreeKey: worktree("w2"),
          aliases: null,
        }),
        repo.link({
          workspaceId,
          resourceDomainId: otherDomain,
          worktreeKey: worktree("w1"),
          aliases: null,
        }),
        repo.link({
          workspaceId: `ws_${randomUUID()}`,
          resourceDomainId: domain,
          worktreeKey: worktree("w1"),
          aliases: null,
        }),
      ]),
    );
    expect(first).toEqual({
      kind: "linked",
      link: { workspaceId, resourceDomainId: domain, worktreeKey: "w1", aliases: null },
    });
    expect(again).toEqual(first);
    expect(moved.kind === "linked" && moved.link.worktreeKey).toBe("w2");
    expect(mapped.kind === "linked" && mapped.link.aliases).toEqual({ mail: "worktree" });
    expect(cleared.kind === "linked" && cleared.link.aliases).toBeNull();
    expect(other).toEqual({ kind: "other-domain", resourceDomainId: domain });
    expect(missing).toEqual({ kind: "no-such-workspace" });
    expect(await run((repo) => repo.links(domain))).toHaveLength(1);
  });

  it("names the live Docker executors of linked workspaces, and the link of a run", async () => {
    const domain = await newDomain();
    const ready = `sealant-${randomUUID()}`;
    const launching = `sealant-${randomUUID()}`;
    const ended = `sealant-${randomUUID()}`;
    const linked = await Promise.all([
      workspaceWithExecutor(ready, "ready"),
      workspaceWithExecutor(launching, "pending"),
      workspaceWithExecutor(ended, "stopped"),
    ]);
    const unlinked = await workspaceWithExecutor(`sealant-${randomUUID()}`, "ready");
    await run((repo) =>
      Effect.all(
        linked.map(({ workspaceId }, index) =>
          repo.link({
            workspaceId,
            resourceDomainId: domain,
            worktreeKey: worktree(`w${String(index)}`),
            aliases: null,
          }),
        ),
      ),
    );
    const executors = await run((repo) => repo.linkedExecutors(domain));
    expect(executors.map((executor) => executor.executor).toSorted()).toEqual(
      [ready, launching].toSorted(),
    );
    const everyDomain = await run((repo) => repo.linkedExecutors());
    expect(everyDomain.map((executor) => executor.executor)).toEqual(
      expect.arrayContaining([ready, launching]),
    );
    expect(await run((repo) => repo.linkOfRun(linked[0]?.runId ?? ""))).toEqual({
      workspaceId: linked[0]?.workspaceId,
      resourceDomainId: domain,
      worktreeKey: "w0",
      aliases: null,
    });
    expect(await run((repo) => repo.linkOfRun(unlinked.runId))).toBeUndefined();
    await run((repo) => repo.unlink(linked[0]?.workspaceId ?? ""));
    expect(
      (await run((repo) => repo.linkedExecutors(domain))).map((executor) => executor.executor),
    ).toEqual([launching]);
  });

  it("gives concurrent allocations distinct subnets, answers a network its own, and frees on release", async () => {
    const octet = 100 + Math.floor(Math.random() * 100);
    const pool = parseSubnetPool(
      `10.${String(octet)}.${String(Math.floor(Math.random() * 250))}.0/24`,
      27,
    );
    const names = Array.from({ length: 8 }, () => `test-${randomUUID()}-reach`);
    const allocations = await run((repo) =>
      Effect.all(
        names.map((name) => repo.allocateNetwork({ name, kind: "reach", owner: name, pool })),
        { concurrency: "unbounded" },
      ),
    );
    const subnets = allocations.map((allocation) =>
      allocation.kind === "allocated" ? allocation.subnet : "exhausted",
    );
    expect(new Set(subnets).size).toBe(8);
    expect(subnets).not.toContain("exhausted");
    const [firstName] = names;
    if (firstName === undefined) throw new Error("names should not be empty");
    const again = await run((repo) =>
      repo.allocateNetwork({ name: firstName, kind: "reach", owner: firstName, pool }),
    );
    expect(again).toEqual(allocations[0]);
    const extra = `test-${randomUUID()}-reach`;
    expect(
      await run((repo) => repo.allocateNetwork({ name: extra, kind: "reach", owner: extra, pool })),
    ).toEqual({ kind: "pool-exhausted" });
    await run((repo) => repo.releaseNetwork(firstName));
    expect(
      await run((repo) => repo.allocateNetwork({ name: extra, kind: "reach", owner: extra, pool })),
    ).toEqual(allocations[0]);
    await run((repo) => Effect.all([...names, extra].map((name) => repo.releaseNetwork(name))));
  });

  it("records what was observed, and the volumes a start mounted", async () => {
    const domain = await newDomain();
    const outcome = await run((repo) =>
      repo.up({ resourceDomainId: domain, key: key("db"), spec: spec(), cause: "use" }),
    );
    if (outcome.kind !== "upserted") throw new Error("up should write");
    const startedAt = new Date();
    await run((repo) =>
      repo.recordObserved(
        outcome.instance.id,
        { kind: "running", since: startedAt.toISOString() },
        {
          startedAt,
          volumes: [
            { name: "data", mountPath: "/var/lib/postgresql" },
            { name: "img-1a2b3c4d", mountPath: "/var/run/extra" },
          ],
        },
      ),
    );
    await run((repo) => repo.touchReached([outcome.instance.id], startedAt));
    const read = await run((repo) => repo.get(domain, key("db")));
    expect(read?.observed).toEqual({ kind: "running", since: startedAt.toISOString() });
    expect(read?.startedAt?.toISOString()).toBe(startedAt.toISOString());
    expect(read?.lastReachedAt?.toISOString()).toBe(startedAt.toISOString());
    expect(read?.volumes).toHaveLength(2);
  });
});
