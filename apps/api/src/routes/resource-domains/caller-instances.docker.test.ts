import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { ResourceInstanceKey } from "@sealant/api-contracts";
import { CredentialCipher, credentialCipherLayer } from "@sealant/credentials";
import {
  createSealantDB,
  ResourceDomainRepo,
  ResourceDomainRepoLive,
  ResourceInstanceRepo,
  ResourceInstanceRepoLive,
  SealantDB,
} from "@sealant/db";
import { Sealant, type ScopeInstanceSpec } from "@sealant/sdk";
import {
  DockerResourceRuntime,
  makeResourceReconciler,
  repositorySubnets,
  resourceSubnetPools,
  parseResourceCallers,
  callerInstanceName,
} from "@sealant/workspaces";
import { Context, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { describe, expect, it } from "vitest";

import { BoatResourceLinkPublisherService } from "../../services/control-plane-capabilities.js";
import { ResourceRuntimeHost } from "../../services/resource-runtime.js";
import { controlPlaneRoutes, gateControlPlane } from "../control-plane.fixture.js";
import { ResourceDomainsHandlersLive } from "./resource-domains.http-api.js";
import { ResourceInstanceBackupRoute } from "./resource-instances.backup.js";
import { ResourceInstanceExecRoute } from "./resource-instances.exec.js";
import { ResourceInstancesHandlersLive } from "./resource-instances.http-api.js";

const docker = async (...args: string[]) =>
  (
    await promisify(execFile)("docker", args, { timeout: 180_000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
const busybox =
  "busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
const enabled =
  process.env.SEALANT_CALLER_DOCKER_E2E === "1" &&
  process.env.SEALANT_TEST_DATABASE_URL !== undefined;

describe.skipIf(!enabled)("caller instances through the public SDK on real Docker", () => {
  it("owns, budgets, isolates, upgrades, restarts, stops and backs up a retained service", async () => {
    const db = await createSealantDB(process.env.SEALANT_TEST_DATABASE_URL ?? "");
    const dbLayer = Layer.succeed(SealantDB, db);
    const cipherLayer = credentialCipherLayer({
      key: Buffer.alloc(32, 29).toString("base64"),
    }).pipe(Layer.orDie);
    const assembly = Layer.mergeAll(
      ResourceDomainRepoLive,
      ResourceInstanceRepoLive,
      cipherLayer,
    ).pipe(Layer.provide(dbLayer));
    const context = await Effect.runPromise(Effect.scoped(Layer.build(assembly)));
    const repo = Context.get(context, ResourceInstanceRepo);
    const budgets = Context.get(context, ResourceDomainRepo);
    const cipher = Context.get(context, CredentialCipher);
    const token = randomUUID().slice(0, 8);
    const client = `coresvc-client-${token}`;
    const outsider = `coresvc-outsider-${token}`;
    const outsiderNetwork = `coresvc-outsider-${token}`;
    const blocker = `coresvc-purge-blocker-${token}`;
    const ids: string[] = [];
    let instanceName: string | undefined;
    let api: Awaited<ReturnType<typeof gateControlPlane>> | undefined;
    let sealant: Sealant | undefined;
    try {
      await docker(
        "run",
        "-d",
        "--name",
        client,
        "--cap-drop",
        "ALL",
        busybox,
        "sh",
        "-c",
        "mkdir /www; echo callback > /www/index.html; httpd -p 4401 -h /www; httpd -p 4402 -h /www; sleep 86400",
      );
      await docker("network", "create", "--internal", outsiderNetwork);
      await docker("network", "connect", outsiderNetwork, client);
      await docker(
        "run",
        "-d",
        "--name",
        outsider,
        "--network",
        outsiderNetwork,
        "--cap-drop",
        "ALL",
        busybox,
        "sleep",
        "86400",
      );
      const runtime = new DockerResourceRuntime({
        subnets: repositorySubnets(
          repo,
          resourceSubnetPools({ reach: "10.229.0.0/16", egress: "10.230.0.0/16" }),
        ),
        callers: parseResourceCallers(
          JSON.stringify([
            { kind: "docker", name: "mend", container: client, callbackPorts: [4401] },
          ]),
        ),
        cipher,
        readyTimeoutMs: 15_000,
      });
      const provides = Layer.mergeAll(
        assembly,
        Layer.succeed(ResourceRuntimeHost, { kind: "docker", runtime }),
        // No workspace here runs on Boat: the link route has nothing to tell the worker.
        Layer.succeed(BoatResourceLinkPublisherService, { publishLinkChanged: async () => {} }),
      );
      const groups: ReadonlyArray<"resourceDomains" | "resourceInstances"> = [
        "resourceDomains",
        "resourceInstances",
      ];
      api = await gateControlPlane(
        Layer.mergeAll(
          controlPlaneRoutes<(typeof groups)[number], Layer.Success<typeof provides>>({
            handlers: Layer.mergeAll(ResourceDomainsHandlersLive, ResourceInstancesHandlersLive),
            provides,
            groups,
          }),
          ResourceInstanceExecRoute.pipe(HttpRouter.provideRequest(provides)),
          ResourceInstanceBackupRoute.pipe(HttpRouter.provideRequest(provides)),
        ),
        `coresvc-key-${token}`,
      );
      sealant = new Sealant({ baseUrl: api.baseUrl, apiKey: `coresvc-key-${token}` });
      const scope = await sealant.scopes.ensure({
        key: `coresvc:${token}`,
        ownerKind: "organization",
        budget: { cpuMillicores: 1000, memoryBytes: 1610612736, storageBytes: 2 * 1024 * 1024 },
      });
      ids.push(scope.id);
      expect(scope.ownerKind).toBe("organization");
      await expect(
        sealant.scopes.ensure({ key: `coresvc:${token}`, ownerKind: "instance" }),
      ).rejects.toMatchObject({ code: "ResourceDomainOwnerDiffersError" });
      const services = sealant.scopes.actAs(scope.id).instances;
      const spec: ScopeInstanceSpec = {
        alias: "executor",
        worktreeKey: null,
        image: busybox,
        command: [
          "sh",
          "-c",
          "[ -e /app/data/index.html ] || echo retained-data > /app/data/index.html; trap 'exit 0' TERM; httpd -p 4400 -h /app/data; while :; do sleep 1 & wait $!; done",
        ],
        env: { DO_NOT_TRACK: "1" },
        volumes: [{ name: "data", mountPath: "/app/data", storageBytes: 1024 * 1024 }],
        limits: { cpuMillicores: 1000, memoryBytes: 1610612736 },
        ready: { kind: "tcp", port: 4400 },
        idleStopAfterSeconds: null,
        reach: { kind: "caller", caller: "mend", port: 4400, callbackPort: 4401 },
      };
      const secret = `synthetic-secret-${token}`;
      const first = await services.up("executor", spec, {
        cause: "person",
        secretEnv: { ORG_SECRET: secret },
      });
      instanceName = callerInstanceName(first.id);
      expect(first.state.kind).toBe("running");
      expect(first.endpoint?.port).toBe(4400);
      const workload = `${instanceName}-workload`;
      await expect(
        services.purge("executor", { expectedInstanceId: first.id }),
      ).rejects.toMatchObject({
        code: "ResourceInstancePurgeRefusedError",
      });
      expect(
        (
          await services.exec("executor", {
            argv: ["sh", "-c", 'printf "%s" "$ORG_SECRET" > /app/data/oauth-token'],
          })
        ).exitCode,
      ).toBe(0);
      expect(await docker("inspect", "--format", "{{.HostConfig.Memory}}", workload)).toBe(
        "1610612736",
      );
      expect(
        await docker("inspect", "--format", "{{len .HostConfig.PortBindings}}", workload),
      ).toBe("0");
      expect(
        await docker("exec", client, "wget", "-qO-", `http://${first.endpoint?.host}:4400`),
      ).toBe("retained-data");
      const callback = await services.exec("executor", {
        argv: ["wget", "-T", "2", "-qO-", "http://mend:4401"],
      });
      expect(callback.exitCode).toBe(0);
      expect(callback.stdout.trim()).toBe("callback");
      expect(
        (await services.exec("executor", { argv: ["wget", "-T", "1", "-qO-", "http://mend:4402"] }))
          .exitCode,
      ).not.toBe(0);
      const address = await docker(
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${instanceName}-caller").IPAddress}}`,
        instanceName,
      );
      await expect(
        docker("exec", outsider, "wget", "-T", "1", "-qO-", `http://${address}:4400`),
      ).rejects.toThrow();
      await expect(
        docker("exec", outsider, "wget", "-T", "1", "-qO-", `http://${instanceName}:4400`),
      ).rejects.toThrow();
      await expect(
        sealant.scopes
          .actAs(scope.id)
          .workspaces.link("missing-workspace", { worktreeKey: "tree" }),
      ).rejects.toMatchObject({ code: "ResourceInstanceSpecRefusedError" });
      await expect(
        docker("exec", outsider, "wget", "-T", "1", "-qO-", `http://${client}:4401`),
      ).rejects.toThrow();
      expect(
        await docker("exec", outsider, "wget", "-T", "1", "-qO-", `http://${client}:4402`),
      ).toBe("callback");
      const before = await docker("inspect", "--format", "{{.Id}}", workload);
      const repeated = await services.up("executor", spec, {
        cause: "person",
        secretEnv: { ORG_SECRET: secret },
      });
      expect(repeated.specDigest).toBe(first.specDigest);
      expect(await docker("inspect", "--format", "{{.Id}}", workload)).toBe(before);
      const release = Promise.withResolvers<void>();
      const acquired = Promise.withResolvers<void>();
      const lock = Effect.runPromise(
        repo.withLock(
          `${scope.id}:executor`,
          Effect.promise(async () => {
            acquired.resolve();
            await release.promise;
          }),
        ),
      );
      await acquired.promise;
      try {
        await expect(
          services.purge("executor", { expectedInstanceId: first.id }),
        ).rejects.toMatchObject({
          code: "ResourceInstanceBusyError",
        });
        await expect(
          services.stop("executor", { kind: "person", by: "concurrent" }),
        ).rejects.toMatchObject({ code: "ResourceInstanceBusyError" });
      } finally {
        release.resolve();
        await lock;
      }
      expect((await services.get("executor")).desired).toBe("running");
      await expect(
        services.up("executor", { ...spec, env: { ORG_SECRET: "plaintext" } }, { cause: "person" }),
      ).rejects.toMatchObject({ code: "ResourceInstanceSpecRefusedError" });
      await expect(
        services.up(
          "executor",
          { ...spec, limits: { ...spec.limits, memoryBytes: 2 * 1610612736 } },
          { cause: "person" },
        ),
      ).rejects.toMatchObject({ code: "ResourceInstanceBudgetError" });
      expect((await services.get("executor")).specDigest).toBe(first.specDigest);
      expect(await docker("inspect", "--format", "{{.Id}}", workload)).toBe(before);
      const stored = await Effect.runPromise(
        repo.get(scope.id, ResourceInstanceKey.make(first.key)),
      );
      expect(stored?.secretEnvSealed).not.toContain(secret);
      expect(JSON.stringify(stored?.spec)).not.toContain(secret);
      expect(JSON.stringify(first)).not.toContain(secret);
      await expect(
        services.up(
          "executor",
          { ...spec, reach: { kind: "caller", caller: "mend", port: 4403, callbackPort: 4401 } },
          { cause: "person" },
        ),
      ).rejects.toMatchObject({ code: "ResourceInstanceSpecRefusedError" });
      await expect(
        services.up("too-much", { ...spec, alias: "second" }, { cause: "person" }),
      ).rejects.toMatchObject({ code: "ResourceInstanceBudgetError" });
      expect(
        await Effect.runPromise(repo.get(scope.id, ResourceInstanceKey.make("too-much"))),
      ).toBeUndefined();
      const budget = await sealant.scopes.actAs(scope.id).budget.get();
      expect(budget.memoryBytes.used).toBe(1610612736);
      expect(budget.storageBytes.used).toBe(1024 * 1024);
      const upgraded = await services.up(
        "executor",
        { ...spec, env: { DO_NOT_TRACK: "1", VERSION: "2" } },
        { cause: "person" },
      );
      expect(upgraded.state.kind).toBe("running");
      expect(await docker("inspect", "--format", "{{.Id}}", workload)).not.toBe(before);
      expect(
        await docker("exec", client, "wget", "-qO-", `http://${first.endpoint?.host}:4400`),
      ).toBe("retained-data");
      expect(
        (await services.exec("executor", { argv: ["sh", "-c", 'test -n "$ORG_SECRET"'] })).exitCode,
      ).toBe(0);
      await docker("kill", workload);
      const reconciler = makeResourceReconciler({ repo, budgets, runtime });
      const tick = await reconciler.tick(new Date("2126-01-01"));
      expect(tick.problems).toEqual([]);
      expect(tick.idleStopped).toEqual([]);
      expect((await services.get("executor")).state.kind).toBe("running");
      const beforeAnchorRestart = await docker("inspect", "--format", "{{.Id}}", workload);
      await docker("restart", "-t", "1", instanceName);
      expect((await reconciler.tick(new Date("2126-01-02"))).problems).toEqual([]);
      expect(await docker("inspect", "--format", "{{.Id}}", workload)).not.toBe(
        beforeAnchorRestart,
      );
      expect(
        await docker("exec", client, "wget", "-qO-", `http://${first.endpoint?.host}:4400`),
      ).toBe("retained-data");
      await expect(services.backup("executor", "data")).rejects.toMatchObject({ status: 409 });
      await services.stop("executor", { kind: "person", by: "test upgrade" });
      const stoppedBudget = await sealant.scopes.actAs(scope.id).budget.get();
      expect(stoppedBudget.memoryBytes.used).toBe(0);
      expect(stoppedBudget.storageBytes.used).toBe(1024 * 1024);
      const tar = Buffer.from(
        await new Response(await services.backup("executor", "data")).arrayBuffer(),
      );
      expect(tar.includes(Buffer.from("retained-data"))).toBe(true);
      expect(tar.includes(Buffer.from(secret))).toBe(true);
      expect((await services.up("executor", spec, { cause: "use" })).desired).toBe("stopped");
      const rotated = await services.up("executor", spec, { cause: "person", secretEnv: {} });
      expect(rotated.state.kind).toBe("running");
      expect(rotated.specDigest).not.toBe(first.specDigest);
      expect(
        (await services.exec("executor", { argv: ["sh", "-c", 'test -z "$ORG_SECRET"'] })).exitCode,
      ).toBe(0);
      const failedSpec: ScopeInstanceSpec = {
        ...spec,
        volumes: [
          ...spec.volumes,
          { name: "extra", mountPath: "/extra", storageBytes: 1024 * 1024 },
        ],
        ready: { kind: "exec", argv: ["false"], user: null },
      };
      expect((await services.up("executor", failedSpec, { cause: "person" })).state.kind).toBe(
        "failed",
      );
      expect((await services.get("executor")).state.kind).toBe("failed");
      await services.stop("executor", { kind: "person", by: "missing volume recovery test" });
      console.log(
        "Removing owned stopped workload and extra test volume:",
        workload,
        `${instanceName}-extra`,
      );
      await docker("rm", workload);
      await docker("volume", "rm", `${instanceName}-extra`);
      expect(
        (await services.up("executor", { ...failedSpec, ready: spec.ready }, { cause: "person" }))
          .state.kind,
      ).toBe("failed");
      await expect(docker("volume", "inspect", `${instanceName}-extra`)).rejects.toThrow();
      const archived = await services.archive("executor");
      expect(archived.volumes).toHaveLength(2);
      expect((await sealant.scopes.actAs(scope.id).budget.get()).storageBytes.used).toBe(
        2 * 1024 * 1024,
      );
      expect(
        await docker("volume", "inspect", "--format", "{{.Name}}", `${instanceName}-data`),
      ).toBe(`${instanceName}-data`);
      const rules = await docker(
        "run",
        "--rm",
        "--name",
        `${instanceName}-caller-guard`,
        "--network",
        `container:${client}`,
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--entrypoint",
        "iptables",
        "nicolaka/netshoot@sha256:47b907d662d139d1e2f22bfe14f4efca1e3f1feed283572f47c970c780c03b61",
        "-S",
        "CORESVC_CB_4401",
      );
      expect(rules).not.toContain(instanceName);
      const archivedName = instanceName;
      await docker(
        "run",
        "-d",
        "--name",
        `${archivedName}-backup`,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--mount",
        `type=volume,src=${archivedName}-data,dst=/data,readonly`,
        busybox,
        "sleep",
        "86400",
      );
      expect(await services.purge("executor", { expectedInstanceId: first.id })).toEqual({
        kind: "purged",
      });
      await expect(docker("inspect", `${archivedName}-backup`)).rejects.toThrow();
      expect(await services.purge("executor", { expectedInstanceId: first.id })).toEqual({
        kind: "already-purged",
      });
      expect(
        await Effect.runPromise(repo.get(scope.id, ResourceInstanceKey.make("executor"))),
      ).toBeUndefined();
      expect(await services.list({ archived: true })).toEqual([]);
      expect((await sealant.scopes.actAs(scope.id).budget.get()).storageBytes.used).toBe(0);
      await expect(docker("volume", "inspect", `${archivedName}-data`)).rejects.toThrow();
      for (const suffix of ["caller", "egress"])
        await expect(docker("network", "inspect", `${archivedName}-${suffix}`)).rejects.toThrow();
      await expect(services.get("executor")).rejects.toMatchObject({
        code: "ResourceInstanceNotFoundError",
      });

      const replacement = await services.up("executor", spec, {
        cause: "person",
        secretEnv: { ORG_SECRET: secret },
      });
      instanceName = callerInstanceName(replacement.id);
      expect(replacement.id).not.toBe(first.id);
      await expect(
        services.purge("executor", { expectedInstanceId: first.id }),
      ).rejects.toMatchObject({
        code: "ResourceInstancePurgeRefusedError",
      });
      await services.stop("executor", { kind: "person", by: "purge" });
      // A failed stop must not make a still-running provider workload deletable.
      await docker("start", `${instanceName}-workload`);
      await expect(
        services.purge("executor", { expectedInstanceId: replacement.id }),
      ).rejects.toMatchObject({
        code: "ResourceInstancePurgeRefusedError",
      });
      expect((await services.get("executor")).desired).toBe("stopped");
      await services.stop("executor", { kind: "person", by: "confirm provider stop" });
      await docker(
        "run",
        "-d",
        "--name",
        blocker,
        "--mount",
        `type=volume,src=${instanceName}-data,dst=/data`,
        busybox,
        "sleep",
        "86400",
      );
      await expect(
        services.purge("executor", { expectedInstanceId: replacement.id }),
      ).rejects.toMatchObject({
        code: "ResourceDomainInternalServerError",
      });
      const retryable = await Effect.runPromise(
        repo.get(scope.id, ResourceInstanceKey.make("executor")),
      );
      expect(retryable).toMatchObject({
        desired: "archived",
        secretEnvSealed: null,
        secretRevision: null,
      });
      expect((await sealant.scopes.actAs(scope.id).budget.get()).storageBytes.used).toBe(
        1024 * 1024,
      );
      await expect(services.up("executor", spec, { cause: "person" })).rejects.toMatchObject({
        code: "ResourceInstanceArchivedError",
      });
      console.log("Removing owned purge blocker:", blocker);
      await docker("rm", "-f", blocker);
      expect(await services.purge("executor", { expectedInstanceId: replacement.id })).toEqual({
        kind: "purged",
      });
      expect(await services.purge("executor", { expectedInstanceId: replacement.id })).toEqual({
        kind: "already-purged",
      });
      const purgedBudget = await sealant.scopes.actAs(scope.id).budget.get();
      expect(purgedBudget.memoryBytes.used).toBe(0);
      expect(purgedBudget.storageBytes.used).toBe(0);
      await expect(docker("volume", "inspect", `${instanceName}-data`)).rejects.toThrow();
      for (const suffix of ["", "-workload", "-backup"])
        await expect(docker("inspect", `${instanceName}${suffix}`)).rejects.toThrow();
    } finally {
      await sealant?.close();
      await api?.close();
      const names = [
        blocker,
        client,
        outsider,
        ...(instanceName === undefined
          ? []
          : [
              `${instanceName}-workload`,
              instanceName,
              `${instanceName}-guard`,
              `${instanceName}-caller-guard`,
              `${instanceName}-probe`,
              `${instanceName}-backup`,
            ]),
      ];
      console.log("Removing owned containers:", names.join(", "));
      for (const name of names) await docker("rm", "-f", name).catch(() => undefined);
      const networks = [
        outsiderNetwork,
        ...(instanceName === undefined ? [] : [`${instanceName}-caller`, `${instanceName}-egress`]),
      ];
      console.log("Removing owned networks:", networks.join(", "));
      for (const network of networks) await docker("network", "rm", network).catch(() => undefined);
      if (instanceName !== undefined) {
        console.log("Removing owned volume:", `${instanceName}-data`);
        await docker("volume", "rm", `${instanceName}-data`).catch(() => undefined);
        console.log("Removing owned volume:", `${instanceName}-extra`);
        await docker("volume", "rm", `${instanceName}-extra`).catch(() => undefined);
      }
      if (ids.length > 0) {
        await Effect.runPromise(
          db.$client.unsafe(
            "delete from resource_domain_allocations where resource_domain_id = any($1::text[])",
            [ids],
          ),
        );
        await Effect.runPromise(
          db.$client.unsafe(
            "delete from resource_instances where resource_domain_id = any($1::text[])",
            [ids],
          ),
        );
        await Effect.runPromise(
          db.$client.unsafe("delete from resource_domains where id = any($1::text[])", [ids]),
        );
      }
      if (instanceName !== undefined)
        await Effect.runPromise(
          db.$client.unsafe("delete from resource_networks where name = any($1::text[])", [
            [`${instanceName}-caller`, `${instanceName}-egress`],
          ]),
        );
    }
  }, 300_000);
});
