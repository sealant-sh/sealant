import { constants, createHash, publicEncrypt, randomUUID } from "node:crypto";

import { CredentialCipher, credentialCipherLayer } from "@sealant/credentials";
import {
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  makeSealantDBLayer,
  SealantDB,
  user,
  workspaceAttempts,
} from "@sealant/db";
import { corruptBoatExecution } from "@sealant/db/testing/boat-executions";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import {
  boatExecutionRecordSchema,
  boatExecutionTargetSchema,
  type BoatExecutionTarget,
} from "@sealant/validators";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BoatSecret } from "./config.js";
import {
  BoatExecution,
  BoatGuestTransportService,
  boatExecutionLayer,
  type BoatGuestTransport,
} from "./execution.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
const secret = (value: string) => {
  const result = BoatSecret.parse(value);
  if (!result.ok) throw result.error;
  return result.value;
};
const requestSchema = z.object({
  format: z.string(),
  identity: z.object({
    deployment_id: z.string(),
    instance_id: z.string(),
    disk_lineage: z.string(),
  }),
  boot_id: z.string(),
  operation_id: z.string(),
  manifest_digest: z.string(),
  public_key: z.string(),
});
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};
const digestCanonical = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
class GuestFixture implements BoatGuestTransport {
  healthy = true;
  badCapabilities = false;
  changedInvocation = false;
  permitLost = false;
  readonly permitBodies: string[] = [];
  readinessCalls = 0;
  async probe() {
    return {
      runtimeId: "rt_fixture",
      healthy: this.healthy,
      supports: this.badCapabilities
        ? []
        : ["exec.user", "dotfiles.user", "restore.owner_map", "process.secret-env.v1"],
    };
  }
  readonly token = "a".repeat(64);
  readonly requests: string[] = [];
  bindLost = false;
  stageLost = false;
  startLost = false;
  wrongTarget = false;
  terminal = false;
  starts = 0;
  hosts = 0;
  isolationLost = false;
  wrongNetworkBinding = false;
  readonly networkBodies: string[] = [];
  stageBodies: string[] = [];
  stageRequest: { operation_id: string; epoch: number } | undefined;
  target: BoatExecutionTarget | undefined;
  bootstrap: z.infer<typeof requestSchema> | undefined;
  beforeBind: () => Promise<void> = async () => {};
  async bind(target: BoatExecutionTarget, raw: unknown) {
    this.target = target;
    const request = requestSchema.parse(raw);
    await this.beforeBind();
    this.requests.push(JSON.stringify(raw));
    if (this.bootstrap !== undefined) expect(request).toEqual(this.bootstrap);
    this.bootstrap = request;
    const label = JSON.stringify([
      request.format,
      target.deploymentId,
      target.sandboxId,
      target.diskLineage,
      target.bootId,
      request.operation_id,
      target.manifestDigest,
    ]);
    const reply = {
      format: "sealant-bootstrap-reply-v1",
      identity: request.identity,
      boot_id: target.bootId,
      operation_id: request.operation_id,
      admission: "held",
      boot: { status: "compatible" },
      ciphertext: publicEncrypt(
        {
          key: request.public_key,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
          oaepLabel: Buffer.from(label),
        },
        Buffer.from(this.token),
      ).toString("base64"),
    };
    if (this.bindLost) {
      this.bindLost = false;
      throw new Error("lost");
    }
    return this.wrongTarget
      ? { ...reply, identity: { ...request.identity, instance_id: "bx_other" } }
      : reply;
  }
  async host() {
    this.hosts++;
    return { origin: "https://fixture-8080.on.boat.dev", cookie: secret("cookie".repeat(8)) };
  }
  async call(
    _host: unknown,
    bearer: BoatSecret,
    route: Parameters<BoatGuestTransport["call"]>[2],
    body?: Redacted.Redacted<string>,
  ) {
    expect(bearer.reveal()).toBe(this.token);
    if (route === "recover") {
      if (body === undefined) throw new Error("missing recovery body");
      const request = z.object({ binding: z.unknown() }).parse(JSON.parse(Redacted.value(body)));
      return {
        format: "sealant-capture-recovery-status-v1",
        binding: request.binding,
        execution: this.terminal ? "issued" : "running",
        mode: this.terminal ? "recovery" : "original",
      };
    }
    if (route === "stage") {
      if (body === undefined) throw new Error("no body");
      const raw = Redacted.value(body);
      this.stageBodies.push(raw);
      const parsed = z
        .object({ operation_id: z.string(), epoch: z.number() })
        .parse(JSON.parse(raw));
      if (this.stageRequest !== undefined) expect(parsed).toEqual(this.stageRequest);
      this.stageRequest = parsed;
      if (this.stageLost) {
        this.stageLost = false;
        throw new Error("lost");
      }
    }
    if (route === "isolate") {
      if (body === undefined) throw new Error("no network body");
      const raw = Redacted.value(body);
      this.networkBodies.push(raw);
      const value = z.object({ binding: z.unknown() }).parse(JSON.parse(raw));
      if (this.isolationLost) {
        this.isolationLost = false;
        throw new Error("lost network reply");
      }
      return {
        format: "sealant-guest-network-status-v1",
        binding: this.wrongNetworkBinding ? {} : value.binding,
        receipt: "e".repeat(64),
        configured: true,
        handshake: "unverified",
        admission: "held",
      };
    }
    if (route === "permit" || route === "readiness") {
      if (body === undefined) throw new Error("missing permit body");
      const raw = Redacted.value(body);
      const value = z
        .object({ binding: z.unknown(), permit_receipt: z.string().optional() })
        .parse(JSON.parse(raw));
      if (route === "permit") {
        this.permitBodies.push(raw);
        if (this.permitLost) {
          this.permitLost = false;
          throw new Error("lost permit response");
        }
        return {
          format: "sealant-execution-permitted-v1",
          binding: value.binding,
          receipt: digestCanonical(JSON.parse(raw)),
          handshake: "verified",
          dns: "udp-and-tcp",
          admission: "held",
        };
      }
      this.readinessCalls++;
      return {
        format: "sealant-readiness-status-v1",
        binding: value.binding,
        permit_receipt: value.permit_receipt,
        invocation:
          this.changedInvocation && this.readinessCalls % 2 === 0 ? "f".repeat(32) : "d".repeat(32),
        handshake: "verified",
        dns: "udp-and-tcp",
        limits: { memory_bytes: 2147483648, cpu_millicores: 1000, tasks: 512 },
        admission: "held",
      };
    }
    if (route === "start") {
      if (this.starts === 0) this.starts++;
      if (this.startLost) {
        this.startLost = false;
        throw new Error("lost");
      }
    }
    if (this.target === undefined) throw new Error("no target");
    return {
      format: "sealant-receiver-status-v1",
      identity: {
        deployment_id: this.target.deploymentId,
        instance_id: this.target.sandboxId,
        disk_lineage: this.target.diskLineage,
      },
      boot_id: this.target.bootId,
      admission: "held",
      execution: this.terminal ? "ended" : this.starts > 0 ? "running" : "unavailable",
      epoch: this.stageRequest?.epoch ?? null,
      operation_id: this.stageRequest?.operation_id ?? null,
      stage: this.stageRequest === undefined ? "empty" : "installed",
    };
  }
}
const payload = (version = "version-one") =>
  Redacted.make({
    files: [
      {
        name: "launch",
        bytes: Buffer.from(
          JSON.stringify({ format: "sealant-daemon-launch-v1", boot_env: { TOKEN: version } }),
        ),
      },
      { name: "dotfiles", bytes: Buffer.from("pinned-archive") },
    ],
    pins: {
      credentialVersions: [{ id: "credential", version }],
      dotfiles: [
        { name: "dotfiles", sha256: createHash("sha256").update("pinned-archive").digest("hex") },
      ],
    },
  });
const test = async (
  run: (context: {
    executor: BoatExecution["Service"];
    repo: BoatExecutionRepo["Service"];
    cipher: CredentialCipher["Service"];
    db: SealantDB["Service"];
    target: BoatExecutionTarget;
    guest: GuestFixture;
  }) => Promise<void>,
) => {
  if (databaseUrl === undefined) throw new Error("SEALANT_TEST_DATABASE_URL required");
  await withWorkspaceJobTestDatabase(databaseUrl, async (url) => {
    const guest = new GuestFixture();
    const Infra = Layer.mergeAll(
      makeSealantDBLayer(url),
      credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") }),
      Layer.succeed(BoatGuestTransportService, guest),
    );
    const Test = boatExecutionLayer.pipe(
      Layer.provideMerge(BoatExecutionRepoLive),
      Layer.provideMerge(Infra),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* BoatExecution;
        const repo = yield* BoatExecutionRepo;
        const cipher = yield* CredentialCipher;
        const db = yield* SealantDB;
        const runId = `run_${randomUUID()}`;
        const owner = `usr_${randomUUID()}`;
        yield* db
          .insert(user)
          .values({ id: owner, name: "boat test", email: `${owner}@example.invalid` });
        yield* db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner });
        const target = boatExecutionTargetSchema.parse({
          deploymentId: "test",
          workspaceId: "workspace",
          runId,
          runtimeInstanceId: runId,
          launchAttemptId: "attempt",
          sourceId: "publication",
          sandboxId: "bx_23456789",
          diskLineage: "disk",
          bootId: randomUUID(),
          manifestDigest: "b".repeat(64),
        });
        yield* Effect.promise(() => run({ executor, repo, cipher, db, target, guest }));
      }).pipe(Effect.provide(Test)),
    );
  });
};
const execute = Effect.runPromise;

describe.runIf(databaseUrl !== undefined)("durable Boat worker ownership", () => {
  it("allows only terminally held original identities to request capture-only recovery", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      await expect(execute(executor.recover(target))).rejects.toThrow("invocation-held");
      await execute(executor.stage(target.runId, payload()));
      await execute(
        executor.permit(target, { resourceReceipt: "e".repeat(64), tunnelReceipt: "f".repeat(64) }),
      );
      await execute(executor.start(target.runId));
      await expect(execute(executor.recover(target))).rejects.toThrow("invocation-held");
      await execute(executor.hold(target));
      const held = await execute(repo.get(target.runId));
      expect(await execute(executor.recover(target))).toBe("running");
      guest.terminal = true;
      expect(await execute(executor.recover(target))).toBe("pending");
      expect(await execute(executor.recover(target))).toBe("pending");
      await expect(execute(executor.recover({ ...target, bootId: randomUUID() }))).rejects.toThrow(
        "target-mismatch",
      );
      expect(await execute(repo.get(target.runId))).toEqual(held);
      await expect(execute(executor.start(target.runId))).rejects.toThrow("invocation-held");
      expect(guest.starts).toBe(1);
    }));
  it("freezes permit receipts before lost delivery, adopts replay and requires fresh authenticated health", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      await execute(executor.stage(target.runId, payload()));
      const receipts = { resourceReceipt: "e".repeat(64), tunnelReceipt: "f".repeat(64) };
      guest.permitLost = true;
      await expect(execute(executor.permit(target, receipts))).rejects.toThrow(
        "transport-unavailable",
      );
      expect((await execute(repo.get(target.runId)))?.isolation).toEqual(receipts);
      await execute(executor.permit(target, receipts));
      expect(new Set(guest.permitBodies).size).toBe(1);
      await expect(
        execute(executor.permit(target, { ...receipts, tunnelReceipt: "a".repeat(64) })),
      ).rejects.toThrow("stale-transition");
      await expect(execute(executor.readiness(target))).rejects.toThrow("invocation-held");
      await execute(executor.start(target.runId));
      expect(await execute(executor.readiness(target))).toMatchObject({
        runtimeId: "rt_fixture",
        handshake: "verified",
        admission: "held",
      });
      guest.healthy = false;
      await expect(execute(executor.readiness(target))).rejects.toThrow("invalid-reply");
      guest.healthy = true;
      guest.badCapabilities = true;
      await expect(execute(executor.readiness(target))).rejects.toThrow("invalid-reply");
      guest.badCapabilities = false;
      guest.changedInvocation = true;
      guest.readinessCalls = 0;
      await expect(execute(executor.readiness(target))).rejects.toThrow("target-mismatch");
      expect(guest.starts).toBe(1);
      await expect(
        execute(executor.readiness({ ...target, bootId: randomUUID() })),
      ).rejects.toThrow("target-mismatch");
    }));
  it("delivers the same authenticated network intent after reply loss and refuses stale epochs, boots and replies", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      const input = {
        network: {
          epoch: 1,
          operationId: String(randomUUID()),
          endpoint: "10.0.0.41",
          subnet: "10.98.0.32/27",
        },
        privateKey: Redacted.make(Buffer.alloc(32, 4).toString("base64")),
        publicKey: Buffer.alloc(32, 5).toString("base64"),
        gatewayKey: Buffer.alloc(32, 6).toString("base64"),
        port: 40000,
      };
      await expect(execute(executor.isolate(target, input))).rejects.toThrow("invocation-held");
      await execute(executor.stage(target.runId, payload()));
      const installed = await execute(repo.get(target.runId));
      if (installed?.admission === null || installed === undefined) throw new Error("no admission");
      input.network.operationId = installed.admission.operationId;
      guest.isolationLost = true;
      await expect(execute(executor.isolate(target, input))).rejects.toThrow(
        "transport-unavailable",
      );
      expect(await execute(executor.isolate(target, input))).toEqual({
        receipt: "e".repeat(64),
        handshake: "unverified",
        admission: "held",
      });
      expect(new Set(guest.networkBodies).size).toBe(1);
      expect(await execute(repo.get(target.runId))).toEqual(installed);
      for (const changed of [{ epoch: 2 }, { operationId: randomUUID() }])
        await expect(
          execute(
            executor.isolate(target, { ...input, network: { ...input.network, ...changed } }),
          ),
        ).rejects.toThrow("target-mismatch");
      await expect(
        execute(executor.isolate({ ...target, bootId: randomUUID() }, input)),
      ).rejects.toThrow("target-mismatch");
      guest.wrongNetworkBinding = true;
      await expect(execute(executor.isolate(target, input))).rejects.toThrow("invalid-reply");
      expect(guest.starts).toBe(0);
      expect(JSON.stringify(installed)).not.toContain(Redacted.value(input.privateKey));
    }));
  it("refuses another run claiming either the owned sandbox or disk before provider delivery", () =>
    test(async ({ executor, target, db, guest }) => {
      await execute(executor.exchange(target));
      for (const changed of [
        { sandboxId: "bx_3456789a", diskLineage: target.diskLineage },
        { sandboxId: target.sandboxId, diskLineage: "another-disk" },
      ]) {
        const runId = `run_${randomUUID()}`;
        const owner = `usr_${randomUUID()}`;
        await execute(
          db
            .insert(user)
            .values({ id: owner, name: "collision", email: `${owner}@example.invalid` }),
        );
        await execute(db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner }));
        const next = boatExecutionTargetSchema.parse({
          ...target,
          ...changed,
          runId,
          runtimeInstanceId: runId,
        });
        await expect(execute(executor.exchange(next))).rejects.toThrow("target-conflict");
      }
      expect(guest.requests).toHaveLength(1);
    }));
  it("refuses an archive pin that does not match delivered bytes before accepting admission", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      const original = Redacted.value(payload());
      await expect(
        execute(
          executor.stage(
            target.runId,
            Redacted.make({
              ...original,
              pins: { ...original.pins, dotfiles: [{ name: "dotfiles", sha256: "f".repeat(64) }] },
            }),
          ),
        ),
      ).rejects.toThrow("invalid-input");
      expect(guest.stageBodies).toHaveLength(0);
      expect((await execute(repo.get(target.runId)))?.phase).toBe("control");
    }));
  it("seals before delivery, replays the same public exchange after reply loss, then erases its key", () =>
    test(async ({ executor, repo, target, guest, cipher }) => {
      guest.beforeBind = async () => {
        const record = await execute(repo.get(target.runId));
        expect(record?.sealedExchange).not.toBeNull();
        expect(record?.sealedControl).toBeNull();
      };
      guest.bindLost = true;
      await expect(execute(executor.exchange(target))).rejects.toThrow("transport-unavailable");
      await execute(executor.exchange(target));
      const record = await execute(repo.get(target.runId));
      expect(record?.phase).toBe("control");
      expect(record?.sealedExchange).toBeNull();
      expect(guest.requests).toHaveLength(2);
      expect(guest.requests[0]).toBe(guest.requests[1]);
      expect(JSON.stringify(record)).not.toContain(guest.token);
      expect(guest.requests.join("")).not.toContain(guest.token);
      if (!record?.sealedControl) throw new Error("missing control");
      const opened = await execute(cipher.decrypt(record.sealedControl));
      expect(opened).toContain(guest.token);
    }));
  it("refuses a mismatched provider reply before committing control", () =>
    test(async ({ executor, repo, target, guest }) => {
      guest.wrongTarget = true;
      await expect(execute(executor.exchange(target))).rejects.toThrow("invalid-reply");
      expect((await execute(repo.get(target.runId)))?.phase).toBe("exchange");
    }));
  it("freezes the exact payload and pins across delivery loss and newer caller credentials", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      guest.stageLost = true;
      await expect(execute(executor.stage(target.runId, payload()))).rejects.toThrow(
        "transport-unavailable",
      );
      const before = await execute(repo.get(target.runId));
      expect(before?.phase).toBe("prepared");
      expect(JSON.stringify(before)).not.toContain("version-one");
      await execute(executor.stage(target.runId, payload("version-two")));
      expect(guest.stageBodies).toHaveLength(2);
      expect(guest.stageBodies[0]).toBe(guest.stageBodies[1]);
      expect(
        Buffer.from(
          z
            .object({ files: z.array(z.object({ data: z.string() })) })
            .parse(JSON.parse(guest.stageBodies[1] ?? "")).files[0]?.data ?? "",
          "base64",
        ).toString(),
      ).toContain("version-one");
    }));
  it("adopts the same started invocation after reply loss and clears launch secrets on settlement", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      await execute(executor.stage(target.runId, payload()));
      await expect(execute(executor.start(target.runId))).rejects.toThrow("invocation-held");
      expect((await execute(repo.get(target.runId)))?.phase).toBe("installed");
      await execute(
        executor.permit(target, { resourceReceipt: "e".repeat(64), tunnelReceipt: "f".repeat(64) }),
      );
      guest.startLost = true;
      await expect(execute(executor.start(target.runId))).rejects.toThrow("transport-unavailable");
      expect((await execute(repo.get(target.runId)))?.phase).toBe("issued");
      expect(await execute(executor.start(target.runId))).toBe("running");
      const settled = await execute(repo.get(target.runId));
      expect(settled?.phase).toBe("running");
      expect(settled?.admission?.sealedEnvelope).toBeNull();
      expect(guest.starts).toBe(1);
      expect(guest.hosts).toBeGreaterThan(2);
      guest.terminal = true;
      await expect(execute(executor.start(target.runId))).rejects.toThrow("invocation-held");
      expect((await execute(repo.get(target.runId)))?.phase).toBe("held");
      expect(guest.starts).toBe(1);
    }));
  it("holds ended invocation and refuses fresh target identities on the same disk", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      await execute(executor.stage(target.runId, payload()));
      await execute(
        executor.permit(target, { resourceReceipt: "e".repeat(64), tunnelReceipt: "f".repeat(64) }),
      );
      guest.terminal = true;
      await expect(execute(executor.start(target.runId))).rejects.toThrow("invocation-held");
      expect((await execute(repo.get(target.runId)))?.admission?.sealedEnvelope).toBeNull();
      for (const changed of [
        { bootId: randomUUID() },
        { diskLineage: "another" },
        { launchAttemptId: "fresh" },
      ])
        await expect(execute(executor.exchange({ ...target, ...changed }))).rejects.toThrow(
          "target-mismatch",
        );
      await expect(execute(executor.start(target.runId))).rejects.toThrow("invocation-held");
    }));
  it("rejects swapped encrypted purposes and malformed persisted state", () =>
    test(async ({ executor, repo, target, db }) => {
      await execute(executor.exchange(target));
      await execute(executor.stage(target.runId, payload()));
      const record = await execute(repo.get(target.runId));
      if (record?.admission === null || record === undefined) throw new Error("no admission");
      await execute(
        corruptBoatExecution(db, target.runId, {
          ...record,
          phase: "prepared",
          admission: { ...record.admission, sealedEnvelope: record.sealedControl },
        }),
      );
      await expect(execute(executor.stage(target.runId, payload()))).rejects.toThrow(
        "seal-context-mismatch",
      );
      await execute(corruptBoatExecution(db, target.runId, { ...record, phase: "nonsense" }));
      await expect(execute(repo.get(target.runId))).rejects.toThrow("invalid-record");
    }));
  it("fences conflicting transitions from the same prior record and adopts an exact replay", () =>
    test(async ({ executor, repo, target, cipher, guest }) => {
      await execute(executor.exchange(target));
      const before = await execute(repo.get(target.runId));
      if (before === undefined) throw new Error("no reservation");
      const proposals = await Promise.all(
        ["one", "two"].map(async (value) =>
          boatExecutionRecordSchema.parse({
            ...before,
            phase: "prepared",
            admission: {
              epoch: 1,
              operationId: randomUUID(),
              digest: createHash("sha256").update(value).digest("hex"),
              sealedEnvelope: (await execute(cipher.encrypt(value))).sealed,
            },
          }),
        ),
      );
      const results = await Promise.allSettled(
        proposals.map((proposal) => execute(repo.advance(before, proposal))),
      );
      const winners = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(winners).toHaveLength(1);
      const winner = winners[0];
      if (winner === undefined) throw new Error("no winner");
      const loser = proposals.find(
        (proposal) => proposal.admission?.operationId !== winner.admission?.operationId,
      );
      if (loser === undefined) throw new Error("no loser");
      expect(await execute(repo.get(target.runId))).toEqual(winner);
      expect(await execute(repo.advance(before, winner))).toEqual(winner);
      await expect(execute(repo.advance(before, loser))).rejects.toThrow("stale-transition");
      await expect(execute(repo.advance(before, { ...before, phase: "held" }))).rejects.toThrow(
        "invalid-record",
      );
      expect(guest.stageBodies).toHaveLength(0);
    }));
  it("keeps one frozen payload when concurrent or later callers stage newer material", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      const results = await Promise.allSettled([
        execute(executor.stage(target.runId, payload("one"))),
        execute(executor.stage(target.runId, payload("two"))),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      for (const result of results)
        if (result.status === "rejected")
          expect(String(result.reason)).toContain("stale-transition");
      expect(guest.stageBodies.length).toBeGreaterThan(0);
      expect(new Set(guest.stageBodies).size).toBe(1);
      const installed = await execute(repo.get(target.runId));
      expect(installed?.phase).toBe("installed");
      const deliveries = guest.stageBodies.length;
      await execute(executor.stage(target.runId, payload("three")));
      expect(guest.stageBodies).toHaveLength(deliveries);
      expect(await execute(repo.get(target.runId))).toEqual(installed);
    }));
});
