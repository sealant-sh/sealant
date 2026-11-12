import { randomUUID } from "node:crypto";

import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
  BoatAccountRepo,
  BoatAccountRepoLive,
  createSealantDB,
  SealantDB,
  user,
  workspaceAttempts,
  type DB,
} from "@sealant/db";
import { corruptBoatRun, seedBoatRun } from "@sealant/db/testing/boat-runs";
import { supersedeNativePublication } from "@sealant/db/testing/native-publications";
import { HttpBoatApi } from "@sealant/workspaces";
import { RecordedBoat } from "@sealant/workspaces/testing/recorded-boat";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

/** Fixture keys only. Organization A's Boat accepts its two keys; B's Boat accepts B's key. */
const KEY_A = "organization-a-key-for-tests";
const KEY_A_NEXT = "organization-a-next-key-tests";
const KEY_B = "organization-b-key-for-tests";

let routes: typeof import("./boat-accounts.module.js");
let availability: typeof import("../../services/boat-availability.js");

const cipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

describe.skipIf(DATABASE_URL === undefined)("Boat accounts API (Postgres)", () => {
  let db: DB;
  const boatA = new RecordedBoat();
  const boatB = new RecordedBoat();
  const urls = new Map<string, string>();

  beforeAll(async () => {
    routes = await import("./boat-accounts.module.js");
    availability = await import("../../services/boat-availability.js");
    db = await createSealantDB(DATABASE_URL ?? "");
    boatA.acceptsOnly = [KEY_A, KEY_A_NEXT];
    boatB.acceptsOnly = [KEY_B];
    const atA = await boatA.listen();
    urls.set(KEY_A, atA);
    urls.set(KEY_A_NEXT, atA);
    urls.set(KEY_B, await boatB.listen());
  });
  afterAll(async () => {
    await Promise.all([boatA.close(), boatB.close()]);
  });

  const layer = () =>
    BoatAccountRepoLive.pipe(
      Layer.provideMerge(Layer.succeed(SealantDB, db)),
      Layer.provideMerge(Layer.succeed(CredentialCipher, cipher)),
    );
  const run = <A, E>(
    effect: Effect.Effect<A, E, BoatAccountRepo | CredentialCipher | SealantDB>,
    configured = true,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(layer()),
        Effect.provideService(availability.BoatConfigured, configured),
        // A key the recorded Boats do not know goes to A's Boat, which refuses it.
        Effect.provideService(availability.BoatKeyClients, (credential) =>
          HttpBoatApi.create({
            credential,
            baseUrl: urls.get(credential.reveal()) ?? urls.get(KEY_A) ?? "",
            timeoutMs: 5_000,
          }),
        ),
      ),
    );
  const refusal = <A, E>(
    effect: Effect.Effect<A, E, BoatAccountRepo | CredentialCipher | SealantDB>,
    configured = true,
  ) => run(Effect.flip(effect), configured);

  /** A live run of the account, with its VM in `boat`. */
  const liveRun = async (accountId: string, boat: RecordedBoat) => {
    const account = await run(Effect.flatMap(BoatAccountRepo, (repo) => repo.get(accountId)));
    if (account === undefined) throw new Error("no account");
    const owner = `usr_${randomUUID()}`;
    const runId = randomUUID();
    const sandboxId = `bx_${"23456789abcdefghjkmnpqrstuvwxyz".charAt(Math.floor(Math.random() * 31))}${"a".repeat(7)}`;
    const target = await Effect.runPromise(
      Effect.gen(function* () {
        yield* db
          .insert(user)
          .values({ id: owner, email: `${owner}@example.invalid`, name: "run" });
        yield* db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner });
        const seeded = yield* seedBoatRun(db, {
          runId,
          sandboxId,
          deploymentId: account.deploymentId,
          accountId,
        });
        // Its image is not this test's: no build of it is in flight.
        yield* supersedeNativePublication(db, seeded.sourceId);
        return seeded;
      }),
    );
    boat.vms.set(sandboxId, {
      id: sandboxId,
      key: randomUUID(),
      labels: {
        "sealant-runtime": "boat",
        "sealant-deployment": target.deploymentId,
        "sealant-workspace": target.workspaceId,
        "sealant-run": runId,
        "sealant-instance": runId,
        "sealant-attempt": target.launchAttemptId,
        "sealant-source": target.sourceId,
      },
      state: "idle",
    });
    return { runId, sandboxId };
  };

  it("stores an account from a key Boat accepts, with one read, and never answers the key", async () => {
    const before = boatA.requests.length;
    const created = await run(
      routes.createBoatAccount({ label: " Organization A ", apiKey: KEY_A }),
    );
    expect(created).toMatchObject({ label: "Organization A", state: "active", keyRotatedAt: null });
    // One read-only call checked the key; nothing was created or changed in Boat.
    expect(boatA.requests.slice(before)).toEqual(["GET /api/v1/sandboxes"]);
    const listed = await run(routes.listBoatAccounts());
    const mine = listed.items.find((item) => item.boatAccountId === created.boatAccountId);
    expect(mine).toEqual(created);
    expect(JSON.stringify(listed)).not.toContain(KEY_A);
    // Stored sealed, under its own deployment label and builder owner.
    const stored = await run(
      Effect.flatMap(BoatAccountRepo, (repo) => repo.sealedKey(created.boatAccountId)),
    );
    expect(stored).toEqual({ sealedKey: `sealed:${KEY_A}`, keyId: "k-test", keyRevision: 1 });
    const record = await run(
      Effect.flatMap(BoatAccountRepo, (repo) => repo.get(created.boatAccountId)),
    );
    expect(record?.deploymentId).toBe(`boat-account-${created.boatAccountId}`);
  });

  it("refuses a key Boat refuses, or one that is not a key, and names neither", async () => {
    const refused = await refusal(
      routes.createBoatAccount({ label: "Refused", apiKey: "not-this-accounts-key-at-all" }),
    );
    expect(refused).toMatchObject({ _tag: "BoatAccountKeyRefusedError", code: "boat-key-refused" });
    expect(JSON.stringify(refused)).not.toContain("not-this-accounts-key-at-all");
    const malformed = await refusal(
      routes.createBoatAccount({ label: "Bad", apiKey: "short key!" }),
    );
    expect(malformed).toMatchObject({ _tag: "BoatAccountBadRequestError" });
    expect(malformed.message).not.toContain("short key!");
    const listed = await run(routes.listBoatAccounts());
    expect(listed.items.map((item) => item.label)).not.toContain("Refused");
    expect(listed.items.map((item) => item.label)).not.toContain("Bad");
  });

  it("is unavailable on an install that does not serve Boat", async () => {
    expect(
      await refusal(routes.createBoatAccount({ label: "Nowhere", apiKey: KEY_A }), false),
    ).toMatchObject({ _tag: "BoatAccountServiceUnavailableError" });
  });

  it("rotates only to a key that sees the account's VMs", async () => {
    const created = await run(routes.createBoatAccount({ label: "Rotating", apiKey: KEY_A }));
    await liveRun(created.boatAccountId, boatA);
    // B's key is another Boat account's: it cannot see A's VM.
    expect(
      await refusal(routes.rotateBoatAccountKey(created.boatAccountId, { apiKey: KEY_B })),
    ).toMatchObject({ _tag: "BoatAccountConflictError", code: "boat-key-cannot-see", unseen: 1 });
    // A launch whose VM Boat has not reported yet: only the current key can find it.
    const pending = await liveRun(created.boatAccountId, boatA);
    await Effect.runPromise(
      corruptBoatRun(db, pending.runId, { sandboxId: null, createdSeenAt: null, target: null }),
    );
    expect(
      await refusal(routes.rotateBoatAccountKey(created.boatAccountId, { apiKey: KEY_A_NEXT })),
    ).toMatchObject({ code: "boat-account-in-use", liveRuns: 1 });
    await Effect.runPromise(
      corruptBoatRun(db, pending.runId, { absentAt: new Date(), absentBasis: "never-created" }),
    );
    const rotated = await run(
      routes.rotateBoatAccountKey(created.boatAccountId, { apiKey: KEY_A_NEXT }),
    );
    expect(rotated.keyRotatedAt).not.toBeNull();
    expect(
      await run(Effect.flatMap(BoatAccountRepo, (repo) => repo.sealedKey(created.boatAccountId))),
    ).toEqual({ sealedKey: `sealed:${KEY_A_NEXT}`, keyId: "k-test", keyRevision: 2 });
    expect(
      await refusal(routes.rotateBoatAccountKey(randomUUID(), { apiKey: KEY_A })),
    ).toMatchObject({ _tag: "BoatAccountNotFoundError" });
  });

  it("refuses removal while the account has a run Boat may hold a VM for, with the count", async () => {
    const created = await run(routes.createBoatAccount({ label: "Removing", apiKey: KEY_A }));
    const live = await liveRun(created.boatAccountId, boatA);
    const inUse = await refusal(routes.removeBoatAccount(created.boatAccountId));
    expect(inUse).toMatchObject({
      _tag: "BoatAccountConflictError",
      code: "boat-account-in-use",
      liveRuns: 1,
      buildsInFlight: 0,
    });
    expect(inUse.message).toContain("1 run whose VM Boat may still hold");
    // Boat no longer has its VM.
    await Effect.runPromise(
      corruptBoatRun(db, live.runId, {
        fencedAt: new Date(),
        deletionClaimedAt: new Date(),
        deletionOperationId: `bdop_${randomUUID().replaceAll("-", "")}`,
        deletionCompletedAt: new Date(),
        absentAt: new Date(),
        absentBasis: "deletion-completed",
      }),
    );
    const removing = await run(routes.removeBoatAccount(created.boatAccountId));
    expect(removing).toMatchObject({ boatAccountId: created.boatAccountId, state: "removing" });
    // Nothing new runs in it, and its key is no longer replaced.
    expect(
      await refusal(routes.rotateBoatAccountKey(created.boatAccountId, { apiKey: KEY_A_NEXT })),
    ).toMatchObject({ code: "boat-account-removing" });
    const spec = { runtime: { boatAccountId: created.boatAccountId } };
    expect(await refusal(availability.requireBoatAccount(spec, "boat"))).toMatchObject({
      _tag: "WorkspaceConflictError",
    });
  });

  it("refuses a workspace that names an unknown account, or one not on Boat", async () => {
    const created = await run(routes.createBoatAccount({ label: "Named", apiKey: KEY_A }));
    expect(
      await refusal(
        availability.requireBoatAccount({ runtime: { boatAccountId: randomUUID() } }, "boat"),
      ),
    ).toMatchObject({ _tag: "WorkspaceNotFoundError" });
    expect(
      await refusal(
        availability.requireBoatAccount(
          { runtime: { boatAccountId: created.boatAccountId } },
          "docker",
        ),
      ),
    ).toMatchObject({ _tag: "WorkspaceBadRequestError" });
    await run(
      availability.requireBoatAccount(
        { runtime: { boatAccountId: created.boatAccountId } },
        "boat",
      ),
    );
    await run(availability.requireBoatAccount({ runtime: {} }, "docker"));
  });
});
