/**
 * An account with a full check that Boat may still hold something of keeps the key that can clean
 * it up (SLNT-784 review), against the fake Boat through the routes: (A) the check's snapshot
 * delete fails while the owner removes the account; (B) the API dies mid-check and the owner
 * removes the account inside the check's claim; (C) the owner rotates the key while the check's VM
 * is still there. Each is refused with the leftover named, and ends with the fake Boat holding
 * nothing of the check once the sweep has run, after which the removal or rotation goes through.
 */
import { randomUUID } from "node:crypto";

import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
  BoatAccountRepo,
  BoatAccountRepoLive,
  BoatKeyProofRepo,
  BoatKeyProofRepoLive,
  createSealantDB,
  SealantDB,
  type DB,
} from "@sealant/db";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import {
  BOAT_KEY_PROOF_CLAIM_MS,
  HttpBoatApi,
  openStoredBoatKey,
  proveBoatKey,
  sweepBoatKeyProofs,
} from "@sealant/workspaces";
import { FakeBoat, type FakeBoatCall } from "@sealant/workspaces/testing/fake-boat";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
/** Fixture keys only: two keys of the one fake Boat account. */
const ACCOUNT_KEY = "boat_live_fixture_proofacct_key_0009";
const ROTATED_KEY = "boat_live_fixture_proofacct_key_0010";

let routes: typeof import("./boat-accounts.module.js");
let availability: typeof import("../../services/boat-availability.js");

const cipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};
const docker = async (args: readonly string[]) => ({
  code: 0,
  stdout: args[0] === "inspect" ? "192.0.10.5\n" : "running\n",
  stderr: "",
  timedOut: false,
});
const failing = { status: 503, code: "service_unavailable", message: "Try again later." };
const call =
  (method: string, path: RegExp) =>
  (seen: FakeBoatCall): boolean =>
    seen.method === method && path.test(seen.path);

describe.skipIf(DATABASE_URL === undefined)(
  "an account whose full check Boat may still hold something of (Postgres, fake Boat)",
  { timeout: 90_000 },
  () => {
    const boat = new FakeBoat({
      runId: `pacct${randomUUID().slice(0, 8)}`,
      credential: ACCOUNT_KEY,
      otherCredentials: [ROTATED_KEY],
      network: "unit",
      baseImage: "unit-base",
      docker,
      deletionWithdrawnMs: 50,
    });
    let db: DB;

    beforeAll(async () => {
      routes = await import("./boat-accounts.module.js");
      availability = await import("../../services/boat-availability.js");
      await boat.start();
    });
    afterAll(async () => {
      await boat.stop();
    });

    const fresh = (body: () => Promise<void>) => () =>
      withWorkspaceJobTestDatabase(DATABASE_URL ?? "", async (url) => {
        db = await createSealantDB(url);
        boat.faults = {};
        await body();
      });
    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        BoatAccountRepo | BoatKeyProofRepo | CredentialCipher | SealantDB
      >,
    ) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.merge(BoatAccountRepoLive, BoatKeyProofRepoLive).pipe(
              Layer.provideMerge(Layer.succeed(SealantDB, db)),
              Layer.provideMerge(Layer.succeed(CredentialCipher, cipher)),
            ),
          ),
          Effect.provideService(availability.BoatKeyClients, (credential, options) =>
            HttpBoatApi.create({
              credential,
              baseUrl: boat.baseUrl,
              timeoutMs: 5_000,
              ...(options?.organization === undefined
                ? {}
                : { organization: options.organization }),
            }),
          ),
        ),
      );
    const refusal = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        BoatAccountRepo | BoatKeyProofRepo | CredentialCipher | SealantDB
      >,
    ) => run(Effect.flip(effect));
    const proofs = () => run(Effect.flatMap(BoatKeyProofRepo, (repo) => Effect.succeed(repo)));
    /** The worker's sweep, as its Boat tick runs it: the account's own stored key opens the client. */
    const sweep = async (at?: Date) =>
      sweepBoatKeyProofs({
        proofs: await proofs(),
        ...(at === undefined ? {} : { now: () => at }),
        pollMs: 20,
        waitMs: 2_000,
        clientFor: async (account) => {
          const key = await openStoredBoatKey({ db, cipher }, account);
          if (key === undefined) return undefined;
          const client = HttpBoatApi.create({
            credential: key.credential,
            baseUrl: boat.baseUrl,
            timeoutMs: 5_000,
          });
          return client.ok ? client.value : undefined;
        },
      });
    /** What the fake Boat holds of any full check, once the deletions it accepted completed. */
    const held = async () => {
      const now = () => ({
        vms: [...boat.sandboxes.values()].filter(
          (sandbox) => sandbox.labels["sealant-key-proof"] !== undefined && !sandbox.removed,
        ).length,
        snapshots: [...boat.snapshots.keys()].filter((name) =>
          name.startsWith("sealant-key-proof-"),
        ).length,
      });
      for (let tries = 0; tries < 100 && (now().vms > 0 || now().snapshots > 0); tries++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      return now();
    };
    const finishRemoval = (id: string) =>
      run(Effect.flatMap(BoatAccountRepo, (repo) => repo.finishRemoval(id)));

    it(
      "(A) a snapshot delete Boat fails: removal is refused naming the snapshot, then goes through once the sweep deleted it",
      fresh(async () => {
        const created = await run(routes.createBoatAccount({ label: "A", apiKey: ACCOUNT_KEY }));
        const deleting = call("DELETE", /^\/saved-snapshots\//);
        boat.faults = { refuse: (seen) => (deleting(seen) ? failing : undefined) };
        const proof = await run(routes.proveBoatAccount(created.boatAccountId));
        expect(proof.leftBehind).toMatchObject({ vm: null, removalConfirmed: false });
        const snapshot = proof.leftBehind.snapshot;
        expect(snapshot).toMatch(/^sealant-key-proof-/);
        // Boat is still failing: the owner is told what is left, and where.
        const refused = await refusal(routes.removeBoatAccount(created.boatAccountId));
        expect(refused).toMatchObject({
          _tag: "BoatAccountConflictError",
          code: "boat-proof-running",
        });
        expect(refused.message).toContain(`saved snapshot ${snapshot ?? ""}`);
        expect(await sweep()).toEqual([{ proofId: proof.proofId, outcome: "pending" }]);
        // Boat recovers: the sweep deletes it, and the removal goes through.
        boat.faults = {};
        expect(await sweep()).toEqual([{ proofId: proof.proofId, outcome: "settled" }]);
        expect(await run(routes.removeBoatAccount(created.boatAccountId))).toMatchObject({
          state: "removing",
        });
        expect(await finishRemoval(created.boatAccountId)).toBe("removed");
        expect(await held()).toEqual({ vms: 0, snapshots: 0 });
      }),
    );

    it(
      "(B) the API dies mid-check: removal is refused inside the claim and the key is never erased first",
      fresh(async () => {
        const created = await run(routes.createBoatAccount({ label: "B", apiKey: ACCOUNT_KEY }));
        const key = await openStoredBoatKey({ db, cipher }, created.boatAccountId);
        if (key === undefined) throw new Error("no key");
        const client = HttpBoatApi.create({
          credential: key.credential,
          baseUrl: boat.baseUrl,
          timeoutMs: 5_000,
        });
        if (!client.ok) throw client.error;
        // The process stops for good once the VM has started.
        const stopped = { reached: false };
        void proveBoatKey({
          proofs: await proofs(),
          account: created.boatAccountId,
          client: client.value,
          pollMs: 20,
          waitMs: 5_000,
          afterStep: async () => {
            stopped.reached = true;
            await new Promise<void>(() => undefined);
          },
        });
        for (let tries = 0; tries < 200 && !stopped.reached; tries++)
          await new Promise((resolve) => setTimeout(resolve, 25));
        expect(stopped.reached).toBe(true);
        const refused = await refusal(routes.removeBoatAccount(created.boatAccountId));
        expect(refused).toMatchObject({ code: "boat-proof-running" });
        expect(refused.message).toMatch(/VM bx_[a-z0-9]+/);
        expect(refused.message).toContain("sealant takes it over from");
        // Even a removal asked for without the API's check is not finished while the check holds.
        await run(
          Effect.flatMap(BoatAccountRepo, (repo) => repo.requestRemoval(created.boatAccountId)),
        );
        expect(await finishRemoval(created.boatAccountId)).toBe("held");
        // Inside the claim the sweep leaves it; once the claim passed it takes it over.
        expect(await sweep()).toEqual([]);
        const later = new Date(Date.now() + BOAT_KEY_PROOF_CLAIM_MS + 1_000);
        expect((await sweep(later))[0]?.outcome).toBe("settled");
        expect(await held()).toEqual({ vms: 0, snapshots: 0 });
        expect(await finishRemoval(created.boatAccountId)).toBe("removed");
      }),
    );

    it(
      "(C) a rotation while the check's VM is still there is refused naming it, and goes through once it is gone",
      fresh(async () => {
        const created = await run(routes.createBoatAccount({ label: "C", apiKey: ACCOUNT_KEY }));
        const deleting = call("DELETE", /^\/sandboxes\/bx_/);
        boat.faults = { refuse: (seen) => (deleting(seen) ? failing : undefined) };
        const proof = await run(routes.proveBoatAccount(created.boatAccountId));
        expect(proof.leftBehind).toMatchObject({ snapshot: null, removalConfirmed: false });
        const vm = proof.leftBehind.vm;
        expect(vm).toMatch(/^bx_/);
        const refused = await refusal(
          routes.rotateBoatAccountKey(created.boatAccountId, { apiKey: ROTATED_KEY }),
        );
        expect(refused).toMatchObject({ code: "boat-proof-running" });
        expect(refused.message).toContain(`VM ${vm ?? ""}`);
        // The store refuses it too, for a rotation that read before the check started.
        const account = await run(
          Effect.flatMap(BoatAccountRepo, (repo) => repo.get(created.boatAccountId)),
        );
        const direct = await refusal(
          Effect.flatMap(BoatAccountRepo, (repo) =>
            repo.rotate(created.boatAccountId, {
              sealedKey: `sealed:${ROTATED_KEY}`,
              keyId: "k-test",
              revision: account?.keyRevision ?? 0,
            }),
          ),
        );
        expect(direct).toMatchObject({ code: "proof-outstanding" });
        boat.faults = {};
        expect(await sweep()).toEqual([{ proofId: proof.proofId, outcome: "settled" }]);
        expect(await held()).toEqual({ vms: 0, snapshots: 0 });
        const rotated = await run(
          routes.rotateBoatAccountKey(created.boatAccountId, { apiKey: ROTATED_KEY }),
        );
        expect(rotated.keyRotatedAt).not.toBeNull();
      }),
    );
  },
);
