/**
 * A scope's `instances`, `workspaces` and `archive` through the SDK, against the API booted in this
 * process: the real contract, transport gate, handlers, raw exec route and repositories on
 * Postgres, with a runtime that records what it was asked instead of driving Docker (the Docker
 * side is `@sealant/workspaces`' e2e). Gated on SEALANT_TEST_DATABASE_URL.
 */
import { createHash, randomUUID } from "node:crypto";

import {
  createSealantDB,
  ResourceDomainRepoLive,
  ResourceInstanceRepoLive,
  schema,
  SealantDB,
  user,
  type DB,
  type ResourceInstanceRecord,
} from "@sealant/db";
import { Sealant, type ScopeInstanceSpec } from "@sealant/sdk";
import type { ReachAttachment, ResourceExecCommand, ResourceRuntime } from "@sealant/workspaces";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ResourceRuntimeHost,
  type ResourceRuntimeHostShape,
} from "../../services/resource-runtime.js";
import { controlPlaneRoutes, gateControlPlane } from "../control-plane.fixture.js";
import { ResourceDomainsHandlersLive } from "./resource-domains.http-api.js";
import { ResourceInstanceExecRoute } from "./resource-instances.exec.js";
import { ResourceInstancesHandlersLive } from "./resource-instances.http-api.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
const TESTED_GROUPS: ReadonlyArray<"resourceDomains" | "resourceInstances"> = [
  "resourceDomains",
  "resourceInstances",
];
const SERVICE_KEY = `slt_instances_${randomUUID()}`;

const postgres: ScopeInstanceSpec = {
  alias: "db",
  worktreeKey: null,
  image: `postgres:18@sha256:${"a".repeat(64)}`,
  command: null,
  env: { POSTGRES_HOST_AUTH_METHOD: "trust" },
  volumes: [{ name: "data", mountPath: "/var/lib/postgresql" }],
  limits: { cpuMillicores: 1000, memoryBytes: 512 * 1024 * 1024 },
  ready: { kind: "exec", argv: ["pg_isready"], user: "postgres" },
  idleStopAfterSeconds: 1800,
};

/** A runtime that answers as Docker would and records what it was asked. */
const recordingRuntime = () => {
  const calls = {
    up: [] as Array<{ readonly key: string; readonly attachments: ReadonlyArray<ReachAttachment> }>,
    stop: [] as Array<string>,
    archive: [] as Array<string>,
    exec: [] as Array<ResourceExecCommand>,
    attach: [] as Array<{ readonly executor: string; readonly aliases: ReadonlyArray<string> }>,
    detach: [] as Array<string>,
  };
  const runtime: ResourceRuntime = {
    up: async (instance, attachments) => {
      calls.up.push({ key: instance.key, attachments });
      const startedAt = new Date();
      return {
        state: { kind: "running", since: startedAt.toISOString() },
        volumes: instance.spec.volumes,
        startedAt,
      };
    },
    stop: async (instance) => {
      calls.stop.push(instance.key);
    },
    archive: async (instance: ResourceInstanceRecord) => {
      calls.archive.push(instance.key);
      return instance.volumes.map((volume) => ({
        name: volume.name,
        dockerName: `sealres-test-${volume.name}`,
        bytes: 4096,
      }));
    },
    exec: async (_instance, command, stdin) => {
      calls.exec.push(command);
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of stdin ?? []) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      return {
        exitCode: 0,
        stdout: `${String(bytes)} ${hash.digest("hex")}`,
        stderr: "",
        truncated: false,
        timedOut: false,
      };
    },
    attachExecutor: async (executor, attachments) => {
      calls.attach.push({
        executor,
        aliases: attachments
          .filter((attachment) => attachment.executor === executor)
          .map((attachment) => attachment.alias),
      });
    },
    detachExecutor: async (executor) => {
      calls.detach.push(executor);
    },
    converge: async () => undefined,
    observe: async () => new Map(),
  };
  return { runtime, calls };
};

describe.skipIf(DATABASE_URL === undefined)("a scope's instances through the SDK", () => {
  let db: DB;
  const recorded = recordingRuntime();
  const apis: Array<Awaited<ReturnType<typeof gateControlPlane>>> = [];
  const clients: Array<Sealant> = [];
  let sealant: Sealant;
  let kubernetes: Sealant;
  const person = `user_instances_sdk_${randomUUID()}`;

  const boot = async (host: ResourceRuntimeHostShape) => {
    const provides = Layer.mergeAll(
      ResourceDomainRepoLive,
      ResourceInstanceRepoLive,
      Layer.succeed(ResourceRuntimeHost, host),
    ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));
    const api = await gateControlPlane(
      Layer.mergeAll(
        controlPlaneRoutes<(typeof TESTED_GROUPS)[number], Layer.Success<typeof provides>>({
          handlers: Layer.mergeAll(ResourceDomainsHandlersLive, ResourceInstancesHandlersLive),
          provides,
          groups: TESTED_GROUPS,
        }),
        ResourceInstanceExecRoute.pipe(HttpRouter.provideRequest(provides)),
      ),
      SERVICE_KEY,
    );
    apis.push(api);
    const client = new Sealant({ baseUrl: api.baseUrl, apiKey: SERVICE_KEY });
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      db.insert(user).values({ id: person, name: "instances", email: `${person}@example.test` }),
    );
    sealant = await boot({ kind: "docker", runtime: recorded.runtime });
    kubernetes = await boot({ kind: "unsupported", runtime: "kubernetes" });
  });

  afterAll(async () => {
    for (const client of clients) await client.close();
    for (const api of apis) await api.close();
  });

  const newScope = async () =>
    sealant.scopes.actAs(
      (await sealant.scopes.ensure({ key: `mend:test:project:${randomUUID()}` })).id,
    );

  /** A workspace whose run's Docker executor is ready under `executor`. */
  const workspaceWithExecutor = async (executor: string) => {
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
      db
        .insert(schema.workspaceRuntimeInstances)
        .values({ runId, adapter: "docker", status: "ready", reference: executor }),
    );
    return workspaceId;
  };

  it("starts an instance and answers it running, once for the same spec twice", async () => {
    const scope = await newScope();
    const first = await scope.instances.up("db", postgres, { cause: "use" });
    expect(first).toMatchObject({ key: "db", alias: "db", desired: "running", stopReason: null });
    expect(first.id).toMatch(/^rin:/);
    expect(first.state.kind).toBe("running");
    expect(first.state.kind === "running" && first.state.since).toBeInstanceOf(Date);
    expect(first.volumes).toEqual([
      { name: "data", dockerName: expect.stringMatching(/^sealres-[0-9a-f]{12}-data$/) },
    ]);
    const second = await scope.instances.up("db", postgres, { cause: "use" });
    expect(second.id).toBe(first.id);
    expect(await scope.instances.get("db")).toEqual(second);
    expect((await scope.instances.list()).map((instance) => instance.key)).toEqual(["db"]);
    await expect(scope.instances.get("nothing")).rejects.toMatchObject({
      code: "ResourceInstanceNotFoundError",
    });
  });

  it("refuses a spec that asks for what an instance may never have, by name", async () => {
    const scope = await newScope();
    const smuggled = { ...postgres, privileged: true, devices: ["/dev/kvm"] };
    const refused = scope.instances.up("db", smuggled, { cause: "use" });
    await expect(refused).rejects.toMatchObject({
      code: "ResourceInstanceSpecRefusedError",
    });
    await expect(refused).rejects.toThrow(
      "Sealant never runs an instance privileged; an instance gets no device",
    );
    expect(await scope.instances.list()).toEqual([]);
  });

  it("keeps a person's stop against use, and a person's start clears it", async () => {
    const scope = await newScope();
    await scope.instances.up("db", postgres, { cause: "use" });
    const stopped = await scope.instances.stop("db", { kind: "person", by: "Maria" });
    expect(stopped).toMatchObject({
      desired: "stopped",
      stopReason: { kind: "person", by: "Maria" },
      state: { kind: "stopped", reason: { kind: "person", by: "Maria" } },
    });
    const starts = recorded.calls.up.length;
    const used = await scope.instances.up("db", postgres, { cause: "use" });
    expect(used.desired).toBe("stopped");
    expect(recorded.calls.up.length).toBe(starts);
    const started = await scope.instances.up("db", postgres, { cause: "person" });
    expect(started).toMatchObject({
      desired: "running",
      stopReason: null,
      state: { kind: "running" },
    });
  });

  it("streams stdin into an exec, and refuses one on an instance that is not running", async () => {
    const scope = await newScope();
    await scope.instances.up("db", postgres, { cause: "use" });
    const payload = Buffer.alloc(8 * 1024 * 1024, 7);
    const chunks = async function* () {
      for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
        yield payload.subarray(offset, offset + 64 * 1024);
      }
    };
    const result = await scope.instances.exec("db", {
      argv: ["pg_restore", "--dbname", "app"],
      user: "postgres",
      stdin: chunks(),
    });
    expect(result).toEqual({
      exitCode: 0,
      stdout: `${String(payload.length)} ${createHash("sha256").update(payload).digest("hex")}`,
      stderr: "",
      truncated: false,
      timedOut: false,
    });
    expect(recorded.calls.exec.at(-1)).toEqual({
      argv: ["pg_restore", "--dbname", "app"],
      user: "postgres",
      timeoutMs: 600_000,
    });
    expect((await scope.instances.get("db")).lastReachedAt).toBeInstanceOf(Date);
    await scope.instances.stop("db", { kind: "person", by: "Maria" });
    await expect(scope.instances.exec("db", { argv: ["true"] })).rejects.toMatchObject({
      code: "ResourceInstanceNotRunningError",
    });
  });

  it("links a workspace and attaches its running executor to what it reaches", async () => {
    const scope = await newScope();
    await scope.instances.up("db", postgres, { cause: "use" });
    await scope.instances.up(
      "mail@w1",
      { ...postgres, alias: "mail", worktreeKey: "w1" },
      { cause: "use" },
    );
    await scope.instances.up(
      "mail@w2",
      { ...postgres, alias: "mail", worktreeKey: "w2" },
      { cause: "use" },
    );
    const executor = `sealant-${randomUUID()}`;
    const workspaceId = await workspaceWithExecutor(executor);
    expect(await scope.workspaces.link(workspaceId, { worktreeKey: "w1" })).toEqual({
      worktreeKey: "w1",
      aliases: null,
      attachedExecutors: 1,
    });
    expect(recorded.calls.attach.at(-1)).toEqual({ executor, aliases: ["db", "mail"] });
    expect(
      await scope.workspaces.link(workspaceId, {
        worktreeKey: "w1",
        aliases: { mail: "worktree" },
      }),
    ).toEqual({ worktreeKey: "w1", aliases: { mail: "worktree" }, attachedExecutors: 1 });
    expect(recorded.calls.attach.at(-1)).toEqual({ executor, aliases: ["mail"] });
    await scope.workspaces.link(workspaceId, { worktreeKey: "w1" });
    const other = await newScope();
    await expect(other.workspaces.link(workspaceId, { worktreeKey: "w1" })).rejects.toMatchObject({
      code: "ResourceWorkspaceLinkedElsewhereError",
    });
    const upAfterLink = await scope.instances.up(
      "cache",
      { ...postgres, alias: "cache" },
      { cause: "use" },
    );
    expect(upAfterLink.state.kind).toBe("running");
    expect(recorded.calls.up.at(-1)?.attachments.map((attachment) => attachment.executor)).toEqual([
      executor,
    ]);
  });

  it("archives an instance and the scope, keeping and listing every volume", async () => {
    const scope = await newScope();
    await scope.instances.up("db", postgres, { cause: "use" });
    await scope.instances.up("cache", { ...postgres, alias: "cache" }, { cause: "use" });
    const executor = `sealant-${randomUUID()}`;
    await scope.workspaces.link(await workspaceWithExecutor(executor), { worktreeKey: "w1" });
    const archived = await scope.instances.archive("cache");
    expect(archived.instance).toMatchObject({ desired: "archived", state: { kind: "archived" } });
    expect(archived.volumes).toEqual([
      { instanceKey: "cache", name: "data", dockerName: "sealres-test-data", bytes: 4096 },
    ]);
    await expect(scope.instances.up("cache", postgres, { cause: "person" })).rejects.toMatchObject({
      code: "ResourceInstanceArchivedError",
    });
    const all = await scope.archive();
    expect(all.volumes.map((volume) => volume.instanceKey)).toEqual(["db"]);
    expect(recorded.calls.detach).toContain(executor);
    expect(
      (await scope.instances.list({ archived: true })).map((instance) => instance.key),
    ).toEqual(["cache", "db"]);
    await expect(scope.instances.up("db2", postgres, { cause: "use" })).rejects.toMatchObject({
      code: "ResourceDomainNotActiveError",
    });
    expect(await scope.archive()).toEqual({ volumes: [] });
  });

  it("refuses every instance on a runtime that is not Docker, by its name", async () => {
    const scope = kubernetes.scopes.actAs(
      (await kubernetes.scopes.ensure({ key: `mend:test:project:${randomUUID()}` })).id,
    );
    const refused = scope.instances.up("db", postgres, { cause: "use" });
    await expect(refused).rejects.toMatchObject({
      code: "ResourceRuntimeUnsupportedError",
    });
    await expect(refused).rejects.toThrow("resources run on Docker; this Sealant runs kubernetes");
    await expect(scope.instances.exec("db", { argv: ["true"] })).rejects.toThrow(
      "resources run on Docker; this Sealant runs kubernetes",
    );
  });
});
