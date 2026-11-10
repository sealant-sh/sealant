import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";

import {
  CredentialCipher,
  CredentialCipherError,
  credentialCipherLayer,
} from "@sealant/credentials";
import {
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  makeSealantDBLayer,
  SealantDB,
  user,
  workspaceAttempts,
} from "@sealant/db";
import { corruptBoatExecution } from "@sealant/db/testing/boat-executions";
import { corruptBoatTunnel, deleteBoatExecutionWithTunnel } from "@sealant/db/testing/boat-tunnels";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import {
  boatExecutionRecordSchema,
  boatExecutionTargetSchema,
  boatWireGuardKeySchema,
  type BoatTunnelBinding,
  type BoatTunnelReservation,
} from "@sealant/validators";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BoatTunnelCredentialsOwner,
  boatTunnelCredentialsLayer,
  boatTunnelCredentialsLayerNoDeps,
  type BoatTunnelCredentials,
} from "./tunnel-credentials.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
const execute = Effect.runPromise;
const publicFor = (key: string) =>
  createPublicKey(
    createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b656e04220420", "hex"),
        Buffer.from(key, "base64"),
      ]),
      format: "der",
      type: "pkcs8",
    }),
  )
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
const rawKeys = (credentials: BoatTunnelCredentials) => ({
  gateway: Redacted.value(credentials.gateway.privateKey),
  guest: Redacted.value(credentials.guest.privateKey),
});
const requireRecord = (record: BoatTunnelReservation | undefined) => {
  if (record === undefined) throw new Error("missing test reservation");
  return record;
};
interface TestContext {
  owner: BoatTunnelCredentialsOwner["Service"];
  repo: BoatTunnelRepo["Service"];
  executions: BoatExecutionRepo["Service"];
  cipher: CredentialCipher["Service"];
  db: SealantDB["Service"];
  seed: (host?: string, deployment?: string) => Promise<BoatTunnelBinding>;
  reopen: (binding: BoatTunnelBinding) => Promise<BoatTunnelCredentials>;
}
const test = async (run: (context: TestContext) => Promise<void>) => {
  if (databaseUrl === undefined) throw new Error("SEALANT_TEST_DATABASE_URL required");
  await withWorkspaceJobTestDatabase(databaseUrl, async (url) => {
    const Infra = Layer.mergeAll(
      makeSealantDBLayer(url),
      credentialCipherLayer({ key: Buffer.alloc(32, 17).toString("base64") }),
    );
    const Test = boatTunnelCredentialsLayerNoDeps.pipe(
      Layer.provideMerge(boatTunnelRepoLayer),
      Layer.provideMerge(BoatExecutionRepoLive),
      Layer.provideMerge(Infra),
    );
    await execute(
      Effect.gen(function* () {
        const owner = yield* BoatTunnelCredentialsOwner;
        const repo = yield* BoatTunnelRepo;
        const executions = yield* BoatExecutionRepo;
        const cipher = yield* CredentialCipher;
        const db = yield* SealantDB;
        const userId = `usr_${randomUUID()}`;
        yield* db
          .insert(user)
          .values({ id: userId, name: "tunnel custody", email: `${userId}@example.invalid` });
        const seed = async (host: string = randomUUID(), deployment = "test") => {
          const runId = randomUUID();
          await execute(db.insert(workspaceAttempts).values({ id: runId, ownerUserId: userId }));
          const target = boatExecutionTargetSchema.parse({
            deploymentId: deployment,
            workspaceId: "workspace",
            runId,
            runtimeInstanceId: runId,
            launchAttemptId: "attempt",
            sourceId: "publication",
            sandboxId: "bx_23456789",
            diskLineage: `disk_${randomUUID()}`,
            bootId: randomUUID(),
            manifestDigest: "b".repeat(64),
          });
          // Every seeded execution owns a different sandbox within its deployment.
          const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
          target.sandboxId = `bx_${randomUUID()
            .replaceAll("-", "")
            .slice(0, 8)
            .split("")
            .map((c) => alphabet[parseInt(c, 16)])
            .join("")}`;
          const before = await execute(
            executions.reserve(
              boatExecutionRecordSchema.parse({
                target,
                exchangeId: randomUUID(),
                publicKey: "p".repeat(100),
                sealedExchange: "test-exchange",
                sealedControl: null,
                admission: null,
                phase: "exchange",
              }),
            ),
          );
          await execute(
            executions.advance(before, {
              ...before,
              phase: "control",
              sealedExchange: null,
              sealedControl: "test-control",
            }),
          );
          return { target, gatewayHostId: host };
        };
        const reopen = (binding: BoatTunnelBinding) =>
          execute(
            Effect.gen(function* () {
              return yield* (yield* BoatTunnelCredentialsOwner).prepare(binding);
            }).pipe(Effect.provide(boatTunnelCredentialsLayer.pipe(Layer.provide(Infra)))),
          );
        yield* Effect.promise(() => run({ owner, repo, executions, cipher, db, seed, reopen }));
      }).pipe(Effect.provide(Test)),
    );
  });
};

describe("WireGuard key boundary", () => {
  it("rejects zero, malformed length and noncanonical padding without accepting a secret as diagnostics", () => {
    for (const value of [
      "A".repeat(43) + "=",
      "A".repeat(42) + "B=",
      "A".repeat(42) + "==",
      "not-a-key",
      "A".repeat(44),
    ])
      expect(boatWireGuardKeySchema.safeParse(value).success).toBe(false);
    expect(boatWireGuardKeySchema.safeParse(Buffer.alloc(32, 1).toString("base64")).success).toBe(
      true,
    );
  });
});

describe.runIf(databaseUrl !== undefined)("durable Boat tunnel custody", () => {
  it("freezes setup on legacy reservations and rejects every changed network field without releasing custody", () =>
    test(async ({ seed, owner, repo, executions, db }) => {
      const binding = await seed();
      await execute(owner.prepare(binding));
      const before = requireRecord(await execute(repo.get(binding.target.runId)));
      expect(before.network).toBeUndefined();
      const network = { epoch: 1, operationId: randomUUID(), subnet: "10.98.0.32/27" };
      await expect(execute(repo.configure(before, network))).rejects.toThrow(
        "execution-unavailable",
      );
      const control = await execute(executions.get(binding.target.runId));
      if (control === undefined) throw new Error("missing control");
      await execute(
        executions.advance(control, {
          ...control,
          phase: "installed",
          admission: {
            epoch: network.epoch,
            operationId: network.operationId,
            digest: "a".repeat(64),
            docker: false,
            sealedEnvelope: "test-envelope",
          },
        }),
      );
      const saved = await execute(repo.configure(before, network));
      expect(await execute(repo.configure(before, network))).toEqual(saved);
      expect(await execute(owner.prepare(binding))).toMatchObject({
        reservationId: before.reservationId,
        listenPort: before.listenPort,
      });
      for (const changed of [
        { epoch: 2 },
        { operationId: randomUUID() },
        { subnet: "10.98.0.64/27" },
      ])
        await expect(execute(repo.configure(saved, { ...network, ...changed }))).rejects.toThrow(
          "binding-conflict",
        );
      expect(await execute(repo.get(binding.target.runId))).toEqual(saved);
      // A reservation frozen before the upgrade may record the address its VM dialled. It still
      // parses, the same intent still matches it, and the record is kept as it was written.
      const dialled = { ...saved, network: { ...network, endpoint: "10.0.0.41" } };
      await execute(corruptBoatTunnel(db, binding.target.runId, dialled));
      expect(await execute(repo.configure(dialled, network))).toEqual(dialled);
      expect(await execute(repo.get(binding.target.runId))).toEqual(dialled);
      for (const changed of [{ epoch: 2 }, { subnet: "10.98.0.64/27" }])
        await expect(execute(repo.configure(dialled, { ...network, ...changed }))).rejects.toThrow(
          "binding-conflict",
        );
    }));
  it("serializes active host mutations and fences later dispatch on close", () =>
    test(async ({ seed, owner, repo, executions }) => {
      const binding = await seed();
      await execute(owner.prepare(binding));
      const control = await execute(executions.get(binding.target.runId));
      if (control === undefined) throw new Error("missing execution");
      const admission = {
        epoch: 1,
        operationId: randomUUID(),
        digest: "a".repeat(64),
        docker: false,
        sealedEnvelope: "sealed",
      };
      await execute(executions.advance(control, { ...control, phase: "installed", admission }));
      const network = {
        epoch: admission.epoch,
        operationId: admission.operationId,
        subnet: "10.98.0.32/27",
      };
      const initial = await execute(
        repo.configure(requireRecord(await execute(repo.get(binding.target.runId))), network),
      );
      const first = randomUUID(),
        second = randomUUID(),
        close = randomUUID();
      expect(await execute(repo.beginUpdate(initial, first))).toBe("issued");
      expect(await execute(repo.beginUpdate(initial, first))).toBe("observe-only");
      await expect(execute(repo.freeze(initial, close))).rejects.toThrow("stale-transition");
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const active = execute(
        repo.withHostLock(
          binding,
          Effect.promise(async () => {
            entered.resolve();
            await release.promise;
          }),
        ),
      );
      await entered.promise;
      let current = requireRecord(await execute(repo.get(binding.target.runId)));
      try {
        await expect(execute(repo.freeze(current, close))).rejects.toThrow("operation-held");
        expect(await execute(repo.beginUpdate(current, second))).toBe("issued");
        await execute(repo.endUpdate(binding, second));
        current = requireRecord(await execute(repo.get(binding.target.runId)));
        expect(current.updates).toEqual([first]);
        await expect(execute(repo.freeze(current, close))).rejects.toThrow("operation-held");
        await expect(
          execute(repo.endUpdate({ ...binding, gatewayHostId: randomUUID() }, first)),
        ).rejects.toThrow("binding-conflict");
        await execute(repo.endUpdate(binding, first));
        await execute(repo.endUpdate(binding, first));
      } finally {
        release.resolve();
        await active;
      }
      current = requireRecord(await execute(repo.get(binding.target.runId)));
      const frozen = await execute(repo.freeze(current, close));
      expect(await execute(repo.freeze(current, close))).toEqual(frozen);
      await expect(execute(repo.beginUpdate(current, randomUUID()))).rejects.toThrow(
        "stale-transition",
      );
      await expect(execute(repo.beginUpdate(frozen, randomUUID()))).rejects.toThrow(
        "operation-held",
      );
      await expect(execute(repo.configure(frozen, network))).rejects.toThrow("operation-held");
      await expect(execute(repo.freeze(frozen, randomUUID()))).rejects.toThrow("binding-conflict");
      expect(requireRecord(await execute(repo.get(binding.target.runId))).listenPort).toBe(
        initial.listenPort,
      );
    }));
  it("reopens exact keys and port through a freshly built production service", () =>
    test(async ({ owner, repo, seed, reopen }) => {
      const binding = await seed();
      const first = await execute(owner.prepare(binding));
      const restored = await reopen(binding);
      expect(restored).toEqual(first);
      expect(rawKeys(restored)).toEqual(rawKeys(first));
      expect(publicFor(Redacted.value(first.gateway.privateKey))).toBe(first.gateway.publicKey);
      expect(publicFor(Redacted.value(first.guest.privateKey))).toBe(first.guest.publicKey);
      expect(first.gateway.publicKey).not.toBe(first.guest.publicKey);
      const persisted = requireRecord(await execute(repo.get(binding.target.runId)));
      for (const key of Object.values(rawKeys(first))) {
        expect(JSON.stringify(persisted)).not.toContain(key);
        expect(JSON.stringify(first)).not.toContain(key);
        expect(String(first.gateway.privateKey)).not.toContain(key);
      }
    }));
  it("converges concurrent first preparations on one durable port and key pair", () =>
    test(async ({ seed, reopen, repo }) => {
      const binding = await seed();
      const results = await Promise.all(Array.from({ length: 8 }, () => reopen(binding)));
      expect(new Set(results.map((value) => value.reservationId)).size).toBe(1);
      expect(new Set(results.map((value) => value.listenPort)).size).toBe(1);
      expect(new Set(results.map((value) => JSON.stringify(rawKeys(value)))).size).toBe(1);
      expect(requireRecord(await execute(repo.get(binding.target.runId))).material).not.toBeNull();
    }));
  it("arbitrates all sixteen ports concurrently across deployments, exhausts visibly, and isolates other hosts", () =>
    test(async ({ seed, owner, repo }) => {
      const host = randomUUID();
      const bindings = await Promise.all(
        Array.from({ length: 16 }, (_, n) => seed(host, `deployment-${n}`)),
      );
      const credentials = await Promise.all(
        bindings.map((binding) => execute(owner.prepare(binding))),
      );
      expect(credentials.map((value) => value.listenPort).toSorted()).toEqual(
        Array.from({ length: 16 }, (_, n) => 40000 + n),
      );
      const exhausted = await seed(host);
      await expect(execute(owner.prepare(exhausted))).rejects.toThrow("ports-exhausted");
      expect(await execute(repo.get(exhausted.target.runId))).toBeUndefined();
      expect((await execute(owner.prepare(await seed()))).listenPort).toBe(40000);
      expect((await execute(owner.prepare(bindings[0] ?? exhausted))).reservationId).toBe(
        credentials[0]?.reservationId,
      );
    }));
  it("refuses a changed host, boot, publication, launch identity or disk without rebinding", () =>
    test(async ({ seed, owner, repo }) => {
      const binding = await seed();
      const first = await execute(owner.prepare(binding));
      for (const changed of [
        { ...binding, gatewayHostId: randomUUID() },
        ...[
          { bootId: randomUUID() },
          { sourceId: "other" },
          { launchAttemptId: "other" },
          { diskLineage: "other" },
        ].map((target) => ({ ...binding, target: { ...binding.target, ...target } })),
      ])
        await expect(execute(owner.prepare(changed))).rejects.toThrow("binding-conflict");
      expect(requireRecord(await execute(repo.get(binding.target.runId))).reservationId).toBe(
        first.reservationId,
      );
    }));
  it("refuses absent, exchange and held executions while retaining previously installed custody", () =>
    test(async ({ seed, owner, repo, executions, db }) => {
      const binding = await seed();
      await expect(
        execute(
          owner.prepare({
            ...binding,
            target: { ...binding.target, runId: "absent", runtimeInstanceId: "absent" },
          }),
        ),
      ).rejects.toThrow("execution-unavailable");
      const original = await execute(executions.get(binding.target.runId));
      if (original === undefined) throw new Error("missing test execution");
      await execute(
        corruptBoatExecution(db, binding.target.runId, {
          ...original,
          phase: "exchange",
          sealedExchange: "test",
          sealedControl: null,
        }),
      );
      await expect(execute(owner.prepare(binding))).rejects.toThrow("execution-unavailable");
      expect(await execute(repo.get(binding.target.runId))).toBeUndefined();
      await execute(corruptBoatExecution(db, binding.target.runId, original));
      await execute(owner.prepare(binding));
      const before = await execute(repo.get(binding.target.runId));
      await execute(
        corruptBoatExecution(db, binding.target.runId, {
          ...original,
          phase: "held",
          admission: {
            operationId: randomUUID(),
            epoch: 1,
            digest: "d".repeat(64),
            docker: false,
            sealedEnvelope: null,
          },
        }),
      );
      await expect(execute(owner.prepare(binding))).rejects.toThrow("execution-unavailable");
      expect(await execute(repo.get(binding.target.runId))).toEqual(before);
    }));
  it("retains a port after failed key sealing and resumes on that original reservation", () =>
    test(async ({ seed, owner, repo, cipher }) => {
      const binding = await seed();
      const failCipher = Layer.succeed(CredentialCipher, {
        encrypt: () =>
          Effect.fail(
            new CredentialCipherError({
              operation: "encrypt",
              message: "sensitive-fixture-diagnostic",
            }),
          ),
        decrypt: cipher.decrypt,
      });
      const Failed = boatTunnelCredentialsLayerNoDeps.pipe(
        Layer.provide(Layer.mergeAll(Layer.succeed(BoatTunnelRepo, repo), failCipher)),
      );
      await expect(
        execute(
          Effect.gen(function* () {
            return yield* (yield* BoatTunnelCredentialsOwner).prepare(binding);
          }).pipe(Effect.provide(Failed)),
        ),
      ).rejects.toThrow("keys-unavailable");
      const pending = requireRecord(await execute(repo.get(binding.target.runId)));
      expect(pending.material).toBeNull();
      const resumed = await execute(owner.prepare(binding));
      expect(resumed.reservationId).toBe(pending.reservationId);
      expect(resumed.listenPort).toBe(pending.listenPort);
    }));
  it("adopts a committed install after a lost reply and refuses changing already installed material", () =>
    test(async ({ seed, owner, repo, cipher }) => {
      const binding = await seed();
      const pending = await execute(repo.reserve(binding, randomUUID()));
      const value = await execute(owner.prepare(binding));
      const saved = requireRecord(await execute(repo.get(binding.target.runId)));
      if (saved.material === null) throw new Error("missing test material");
      expect(
        await execute(
          repo.install(pending, {
            ...saved.material,
            sealedKeys: (await execute(cipher.encrypt("loser"))).sealed,
          }),
        ),
      ).toEqual(saved);
      await expect(execute(repo.install(saved, saved.material))).rejects.toThrow(
        "stale-transition",
      );
      await expect(
        execute(repo.install({ ...pending, reservationId: randomUUID() }, saved.material)),
      ).rejects.toThrow("stale-transition");
      expect(rawKeys(await execute(owner.prepare(binding)))).toEqual(rawKeys(value));
    }));
  it("refuses a reservation identifier collision without claiming another port", () =>
    test(async ({ seed, repo }) => {
      const one = await seed();
      const first = await execute(repo.reserve(one, randomUUID()));
      const two = await seed(one.gatewayHostId);
      await expect(execute(repo.reserve(two, first.reservationId))).rejects.toThrow(
        "binding-conflict",
      );
      expect(await execute(repo.get(two.target.runId))).toBeUndefined();
    }));
  it("canonicalizes UUID spelling before comparing stored host and reservation identities", () =>
    test(async ({ seed, repo, owner }) => {
      const binding = await seed(randomUUID().toUpperCase());
      const id = randomUUID().toUpperCase();
      const reserved = await execute(repo.reserve(binding, id));
      expect(reserved.reservationId).toBe(id.toLowerCase());
      expect(reserved.binding.gatewayHostId).toBe(binding.gatewayHostId.toLowerCase());
      const credentials = await execute(owner.prepare(binding));
      expect(await execute(owner.prepare(reserved.binding))).toEqual(credentials);
    }));
  it("authenticates complete reservation context and both public/private relationships", () =>
    test(async ({ seed, owner, repo, cipher, db }) => {
      const one = await seed();
      const two = await seed(one.gatewayHostId);
      await execute(owner.prepare(one));
      await execute(owner.prepare(two));
      const first = requireRecord(await execute(repo.get(one.target.runId)));
      const second = requireRecord(await execute(repo.get(two.target.runId)));
      if (first.material === null || second.material === null)
        throw new Error("missing test material");
      const opened = z
        .object({
          context: z.record(z.string(), z.unknown()),
          keys: z.object({ gateway: z.string(), guest: z.string() }),
        })
        .parse(JSON.parse(await execute(cipher.decrypt(first.material.sealedKeys))));
      for (const material of [
        second.material,
        { ...first.material, guestPublicKey: second.material.guestPublicKey },
        {
          ...first.material,
          sealedKeys: (
            await execute(
              cipher.encrypt(
                JSON.stringify({ ...opened, keys: { ...opened.keys, guest: opened.keys.gateway } }),
              ),
            )
          ).sealed,
        },
        {
          ...first.material,
          sealedKeys: (
            await execute(
              cipher.encrypt(
                JSON.stringify({ ...opened, context: { ...opened.context, listenPort: 40015 } }),
              ),
            )
          ).sealed,
        },
      ]) {
        await execute(corruptBoatTunnel(db, one.target.runId, { ...first, material }));
        await expect(execute(owner.prepare(one))).rejects.toThrow("seal-context-mismatch");
      }
    }));
  it("refuses malformed stored records and ciphertext with safe errors", () =>
    test(async ({ seed, owner, repo, db }) => {
      const binding = await seed();
      await execute(owner.prepare(binding));
      const saved = requireRecord(await execute(repo.get(binding.target.runId)));
      if (saved.material === null) throw new Error("missing test material");
      await execute(
        corruptBoatTunnel(db, binding.target.runId, { ...saved, unexpected: "private-value" }),
      );
      await expect(execute(owner.prepare(binding))).rejects.toThrow("invalid-record");
      await execute(
        corruptBoatTunnel(db, binding.target.runId, {
          ...saved,
          material: { ...saved.material, sealedKeys: "v1.sensitive-key-id.a.b.c" },
        }),
      );
      const failure = await execute(owner.prepare(binding).pipe(Effect.flip));
      expect(String(failure)).toContain("keys-unavailable");
      expect(JSON.stringify(failure)).not.toContain("sensitive-key-id");
      expect(failure).not.toHaveProperty("cause");
    }));
  it("protects the outstanding reservation from generic execution deletion", () =>
    test(async ({ seed, owner, repo, db }) => {
      const binding = await seed();
      await execute(owner.prepare(binding));
      await expect(
        execute(deleteBoatExecutionWithTunnel(db, binding.target.runId)),
      ).rejects.toThrow();
      expect(await execute(repo.get(binding.target.runId))).toBeDefined();
    }));
});
