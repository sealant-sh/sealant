import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";

import {
  CredentialCipher,
  CredentialCipherError,
  credentialCipherLayer,
} from "@sealant/credentials";
import {
  BoatRunRepo,
  BoatRunRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  makeSealantDBLayer,
  SealantDB,
  user,
  workspaceAttempts,
} from "@sealant/db";
import { corruptBoatRun, seedBoatRun } from "@sealant/db/testing/boat-runs";
import {
  corruptBoatTunnel,
  deleteBoatRunWithTunnel,
  occupyBoatTunnelPorts,
} from "@sealant/db/testing/boat-tunnels";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import {
  BOAT_TUNNEL_LEGACY_PORTS,
  BOAT_TUNNEL_PORTS,
  boatTunnelReservationSchema,
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
/** A run whose bind exchange finished: its bearer is sealed and nothing is staged. */
const CONTROL = {
  exchangeId: randomUUID(),
  exchangePublicKey: "p".repeat(100),
  sealedExchange: null,
  sealedControl: "test-control",
};
const requireRecord = (record: BoatTunnelReservation | undefined) => {
  if (record === undefined) throw new Error("missing test reservation");
  return record;
};
interface TestContext {
  owner: BoatTunnelCredentialsOwner["Service"];
  repo: BoatTunnelRepo["Service"];
  runs: BoatRunRepo["Service"];
  cipher: CredentialCipher["Service"];
  db: SealantDB["Service"];
  seed: (host?: string, deployment?: string) => Promise<BoatTunnelBinding>;
  /** Hold these ports of a host with reservations written straight to the tables. */
  occupy: (host: string, ports: readonly number[]) => Promise<void>;
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
      Layer.provideMerge(BoatRunRepoLive),
      Layer.provideMerge(Infra),
    );
    await execute(
      Effect.gen(function* () {
        const owner = yield* BoatTunnelCredentialsOwner;
        const repo = yield* BoatTunnelRepo;
        const runs = yield* BoatRunRepo;
        const cipher = yield* CredentialCipher;
        const db = yield* SealantDB;
        const userId = `usr_${randomUUID()}`;
        yield* db
          .insert(user)
          .values({ id: userId, name: "tunnel custody", email: `${userId}@example.invalid` });
        const seed = async (host: string = randomUUID(), deployment = "test") => {
          const runId = randomUUID();
          await execute(db.insert(workspaceAttempts).values({ id: runId, ownerUserId: userId }));
          // Every seeded run owns a different sandbox within its deployment.
          const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
          const sandboxId = `bx_${randomUUID()
            .replaceAll("-", "")
            .slice(0, 8)
            .split("")
            .map((c) => alphabet[parseInt(c, 16)])
            .join("")}`;
          const target = await execute(
            seedBoatRun(db, { runId, deploymentId: deployment, sandboxId }),
          );
          // Its bearer is sealed: the launch state a tunnel is first reserved in.
          await execute(corruptBoatRun(db, runId, CONTROL));
          return { target, gatewayHostId: host };
        };
        const reopen = (binding: BoatTunnelBinding) =>
          execute(
            Effect.gen(function* () {
              return yield* (yield* BoatTunnelCredentialsOwner).prepare(binding);
            }).pipe(Effect.provide(boatTunnelCredentialsLayer.pipe(Layer.provide(Infra)))),
          );
        const occupy = (host: string, ports: readonly number[]) =>
          execute(occupyBoatTunnelPorts(db, { gatewayHostId: host, ownerUserId: userId, ports }));
        yield* Effect.promise(() => run({ owner, repo, runs, cipher, db, seed, occupy, reopen }));
      }).pipe(Effect.provide(Test)),
    );
  });
};

/** Whether a reservation on this host port parses. */
const reservation = (listenPort: number) =>
  boatTunnelReservationSchema.safeParse({
    binding: {
      target: {
        deploymentId: "test",
        workspaceId: "workspace",
        runId: "run",
        runtimeInstanceId: "run",
        launchAttemptId: "attempt",
        sourceId: "publication",
        sandboxId: "bx_23456789",
        diskLineage: "disk",
        bootId: randomUUID(),
        manifestDigest: "b".repeat(64),
      },
      gatewayHostId: randomUUID(),
    },
    reservationId: randomUUID(),
    listenPort,
    material: null,
  }).success;

describe("tunnel port boundary", () => {
  it("accepts a reservation on a port of either range, and on no other", () => {
    for (const port of [40000, 40015, BOAT_TUNNEL_PORTS.first, BOAT_TUNNEL_PORTS.last])
      expect(reservation(port), String(port)).toBe(true);
    for (const port of [39999, 40016, 51820, 60999, BOAT_TUNNEL_PORTS.last + 1, 61000.5])
      expect(reservation(port), String(port)).toBe(false);
    expect(BOAT_TUNNEL_PORTS).toEqual({ first: 61000, last: 61511 });
    expect(BOAT_TUNNEL_LEGACY_PORTS).toEqual({ first: 40000, last: 40015 });
  });
});

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
    test(async ({ seed, owner, repo, runs, db }) => {
      const binding = await seed();
      await execute(owner.prepare(binding));
      const before = requireRecord(await execute(repo.get(binding.target.runId)));
      expect(before.network).toBeUndefined();
      const network = { epoch: 1, operationId: randomUUID(), subnet: "10.98.0.32/27" };
      await expect(execute(repo.configure(before, network))).rejects.toThrow(
        "execution-unavailable",
      );
      await execute(
        runs.stage(binding.target.runId, {
          epoch: network.epoch,
          operationId: network.operationId,
          digest: "a".repeat(64),
          docker: false,
          sealedLaunch: "test-envelope",
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
    test(async ({ seed, owner, repo, runs }) => {
      const binding = await seed();
      await execute(owner.prepare(binding));
      const admission = {
        epoch: 1,
        operationId: randomUUID(),
        digest: "a".repeat(64),
        docker: false,
        sealedLaunch: "sealed",
      };
      await execute(runs.stage(binding.target.runId, admission));
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
  it("arbitrates ports concurrently across deployments, above the first allocator's sixteen, and isolates other hosts", () =>
    test(async ({ seed, owner }) => {
      const host = randomUUID();
      // More sessions at once than the first allocator's range could hold on one host.
      const bindings = await Promise.all(
        Array.from({ length: 24 }, (_, n) => seed(host, `deployment-${n}`)),
      );
      const credentials = await Promise.all(
        bindings.map((binding) => execute(owner.prepare(binding))),
      );
      expect(credentials.map((value) => value.listenPort).toSorted()).toEqual(
        Array.from({ length: 24 }, (_, n) => BOAT_TUNNEL_PORTS.first + n),
      );
      expect(BOAT_TUNNEL_PORTS.first).toBeGreaterThan(BOAT_TUNNEL_LEGACY_PORTS.last);
      expect(BOAT_TUNNEL_PORTS.last - BOAT_TUNNEL_PORTS.first + 1).toBeGreaterThanOrEqual(300);
      // Above Linux's default ephemeral range, where a port may be an outbound socket's source.
      expect(BOAT_TUNNEL_PORTS.first).toBeGreaterThan(60999);
      expect((await execute(owner.prepare(await seed()))).listenPort).toBe(BOAT_TUNNEL_PORTS.first);
      expect((await execute(owner.prepare(bindings[0] ?? (await seed())))).reservationId).toBe(
        credentials[0]?.reservationId,
      );
    }));
  it("hands out every port of the range, the last one included, and refuses visibly once it is full", () =>
    test(async ({ seed, owner, repo, occupy }) => {
      const host = randomUUID();
      const range = Array.from(
        { length: BOAT_TUNNEL_PORTS.last - BOAT_TUNNEL_PORTS.first + 1 },
        (_, n) => BOAT_TUNNEL_PORTS.first + n,
      );
      // Every port but two is held, one of the free ones in the middle and one at the very end.
      const middle = BOAT_TUNNEL_PORTS.first + 137;
      await occupy(
        host,
        range.filter((port) => port !== middle && port !== BOAT_TUNNEL_PORTS.last),
      );
      expect((await execute(owner.prepare(await seed(host)))).listenPort).toBe(middle);
      expect((await execute(owner.prepare(await seed(host)))).listenPort).toBe(
        BOAT_TUNNEL_PORTS.last,
      );
      const exhausted = await seed(host);
      await expect(execute(owner.prepare(exhausted))).rejects.toThrow("ports-exhausted");
      expect(await execute(repo.get(exhausted.target.runId))).toBeUndefined();
      // Another host's range is its own.
      expect((await execute(owner.prepare(await seed()))).listenPort).toBe(BOAT_TUNNEL_PORTS.first);
    }));
  it("keeps a port the first allocator reserved valid until its run ends, and never hands one out again", () =>
    test(async ({ seed, owner, occupy }) => {
      const host = randomUUID();
      const legacy = Array.from(
        { length: BOAT_TUNNEL_LEGACY_PORTS.last - BOAT_TUNNEL_LEGACY_PORTS.first + 1 },
        (_, n) => BOAT_TUNNEL_LEGACY_PORTS.first + n,
      );
      // Rows as the release before this one wrote them still satisfy the database's check.
      await occupy(host, legacy);
      // The old range being full is no exhaustion: the next session gets a port of the new one.
      expect((await execute(owner.prepare(await seed(host)))).listenPort).toBe(
        BOAT_TUNNEL_PORTS.first,
      );
      // And the old range being free is no room: with the new one full, nothing is handed out.
      const other = randomUUID();
      await occupy(
        other,
        Array.from(
          { length: BOAT_TUNNEL_PORTS.last - BOAT_TUNNEL_PORTS.first + 1 },
          (_, n) => BOAT_TUNNEL_PORTS.first + n,
        ),
      );
      await expect(execute(owner.prepare(await seed(other)))).rejects.toThrow("ports-exhausted");
      // A port outside both ranges is refused by the database itself.
      for (const port of [
        BOAT_TUNNEL_LEGACY_PORTS.last + 1,
        BOAT_TUNNEL_PORTS.first - 1,
        BOAT_TUNNEL_PORTS.last + 1,
      ])
        await expect(occupy(randomUUID(), [port]), String(port)).rejects.toThrow();
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
    test(async ({ seed, owner, repo, db }) => {
      const binding = await seed();
      await expect(
        execute(
          owner.prepare({
            ...binding,
            target: { ...binding.target, runId: "absent", runtimeInstanceId: "absent" },
          }),
        ),
      ).rejects.toThrow("execution-unavailable");
      // Its bind exchange still in flight: no bearer is sealed, so no tunnel is reserved.
      await execute(
        corruptBoatRun(db, binding.target.runId, { sealedExchange: "test", sealedControl: null }),
      );
      await expect(execute(owner.prepare(binding))).rejects.toThrow("execution-unavailable");
      expect(await execute(repo.get(binding.target.runId))).toBeUndefined();
      await execute(corruptBoatRun(db, binding.target.runId, CONTROL));
      await execute(owner.prepare(binding));
      const before = await execute(repo.get(binding.target.runId));
      // Fenced after its launch was pushed: held.
      await execute(
        corruptBoatRun(db, binding.target.runId, {
          admissionOperationId: randomUUID(),
          admissionEpoch: 1,
          admissionDigest: "d".repeat(64),
          docker: false,
          launchIssuedAt: new Date(Date.now() - 1_000),
          fencedAt: new Date(Date.now() - 1_000),
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
                JSON.stringify({
                  ...opened,
                  context: { ...opened.context, listenPort: BOAT_TUNNEL_PORTS.last },
                }),
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
  it("protects the outstanding reservation from deletion of its run's row", () =>
    test(async ({ seed, owner, repo, db }) => {
      const binding = await seed();
      await execute(owner.prepare(binding));
      await expect(execute(deleteBoatRunWithTunnel(db, binding.target.runId))).rejects.toThrow();
      expect(await execute(repo.get(binding.target.runId))).toBeDefined();
    }));
});
