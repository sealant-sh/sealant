/**
 * The wallet a stored account bills, through the routes, against the fake Boat (which keeps each
 * wallet's VMs and snapshots apart): a personal key is pinned at connect to the wallet it bills,
 * and the report lists the wallets it can bill; the pin changes without the key and never to none;
 * what the account made stays recorded in its wallet (nothing is deleted first, no workspace is
 * refused); a change is refused, with the counts, while something lives in the wallet it names; an
 * account connected before pins waits for the worker; a rotation must see each image where it was
 * made; and released clients still decode what changed.
 */
import { randomUUID } from "node:crypto";

import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
  BoatAccountRepo,
  BoatAccountRepoLive,
  BoatKeyProofRepo,
  BoatKeyProofRepoLive,
  BoatRunRepo,
  BoatRunRepoLive,
  createSealantDB,
  schema,
  SealantDB,
  user,
  workspaceAttempts,
  type DB,
} from "@sealant/db";
import { corruptBoatRun, seedBoatRun } from "@sealant/db/testing/boat-runs";
import {
  releaseNativeConsumers,
  supersedeNativePublication,
} from "@sealant/db/testing/native-publications";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import { BoatSecret, HttpBoatApi } from "@sealant/workspaces";
import { FakeBoat } from "@sealant/workspaces/testing/fake-boat";
import { Effect, Exit, Layer, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
/** Fixture keys only: the fake Boat accepts the account key; the install key is another. */
const ACCOUNT_KEY = "boat_live_fixture_wallet_key_0005";
/** A key of another person's Boat account (another fake Boat). */
const OTHER_KEY = "boat_live_fixture_other_key_0007";
const INSTALL_KEY = "boat_live_fixture_install_key_0006";
const SANDBOX_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

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

/** A person's Boat account in two organizations, `acme` its active wallet. */
const TWO_ORGANIZATIONS = [
  { id: "usr_fake", name: "fake-owner", type: "personal", role: "owner", active: false },
  { id: "team_acme", name: "acme", type: "org", role: "admin", active: true },
  { id: "team_zeta", name: "zeta", type: "org", role: "member", active: false },
];

/** The snapshot name a seeded image carries. */
const imageName = (id: string) => `sealant-${id.slice(0, 8)}`;

describe.skipIf(DATABASE_URL === undefined)(
  "a Boat account's organization, after it is connected (Postgres, fake Boat)",
  { timeout: 60_000 },
  () => {
    let db: DB;
    const boat = new FakeBoat({
      runId: `wallet${randomUUID().slice(0, 6)}`,
      credential: ACCOUNT_KEY,
      network: "unit",
      baseImage: "unit-base",
      docker,
    });
    const other = new FakeBoat({
      runId: `other${randomUUID().slice(0, 6)}`,
      credential: OTHER_KEY,
      network: "unit",
      baseImage: "unit-base",
      docker,
    });

    beforeAll(async () => {
      routes = await import("./boat-accounts.module.js");
      availability = await import("../../services/boat-availability.js");
      db = await createSealantDB(DATABASE_URL ?? "");
      await Promise.all([boat.start(), other.start()]);
    });
    afterAll(async () => {
      await Promise.all([boat.stop(), other.stop()]);
    });
    beforeEach(() => {
      boat.account = { orgs: TWO_ORGANIZATIONS, activeWallet: "team_acme" };
      boat.faults = {};
      boat.organizationHeaders.length = 0;
      boat.snapshots.clear();
      boat.sandboxes.clear();
    });

    type Services = BoatAccountRepo | BoatKeyProofRepo | BoatRunRepo | CredentialCipher | SealantDB;
    const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.mergeAll(BoatAccountRepoLive, BoatKeyProofRepoLive, BoatRunRepoLive).pipe(
              Layer.provideMerge(Layer.succeed(SealantDB, db)),
              Layer.provideMerge(Layer.succeed(CredentialCipher, cipher)),
            ),
          ),
          Effect.provideService(availability.BoatConfigured, true),
          Effect.provideService(availability.BoatDefaultKey, () => BoatSecret.parse(INSTALL_KEY)),
          Effect.provideService(availability.BoatKeyClients, (credential, options) =>
            HttpBoatApi.create({
              credential,
              baseUrl: credential.reveal() === OTHER_KEY ? other.baseUrl : boat.baseUrl,
              timeoutMs: 5_000,
              ...(options?.organization === undefined
                ? {}
                : { organization: options.organization }),
            }),
          ),
        ),
      );
    const refusal = <A, E>(effect: Effect.Effect<A, E, Services>) => run(Effect.flip(effect));
    const stored = (id: string) =>
      run(Effect.flatMap(BoatAccountRepo, (repo) => repo.get(id))).then((account) => {
        if (account === undefined) throw new Error("no account");
        return account;
      });
    const connect = (label: string) =>
      run(routes.createBoatAccount({ label, apiKey: ACCOUNT_KEY }));
    /** Where the fake's logs stand: every request, and every one that named a wallet. */
    const mark = () => ({
      sent: boat.events.filter((event) => event.kind === "api").length,
      named: boat.organizationHeaders.length,
    });
    /** Every request since `from` named `organization`; none lacked it. */
    const everyRequestNamed = (from: ReturnType<typeof mark>, organization: string) => {
      const sent = boat.events.filter((event) => event.kind === "api").length - from.sent;
      const named = boat.organizationHeaders.slice(from.named);
      expect(sent).toBeGreaterThan(0);
      expect(named).toHaveLength(sent);
      expect(new Set(named.map((each) => each.organization))).toEqual(new Set([organization]));
    };

    /** A run of the account whose VM Boat may hold: no absence committed. */
    const liveRun = async (accountId: string) => {
      const account = await stored(accountId);
      const owner = `usr_${randomUUID()}`;
      const runId = randomUUID();
      const sandboxId = `bx_${Array.from(
        { length: 8 },
        () => SANDBOX_ID_ALPHABET[Math.floor(Math.random() * SANDBOX_ID_ALPHABET.length)],
      ).join("")}`;
      const seeded = await Effect.runPromise(
        Effect.gen(function* () {
          yield* db
            .insert(user)
            .values({ id: owner, email: `${owner}@example.invalid`, name: "run" });
          yield* db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner });
          const target = yield* seedBoatRun(db, {
            runId,
            sandboxId,
            deploymentId: account.deploymentId,
            accountId,
          });
          yield* supersedeNativePublication(db, target.sourceId);
          return target;
        }),
      );
      return { runId, publicationId: seeded.sourceId };
    };
    /**
     * A saved image sealant built in the account, ready: what retention and removal delete. `wallet`:
     * the fake Boat holds it there too, as the wallet the account billed when it was saved.
     */
    const savedImage = async (
      accountId: string,
      state: "ready" | "reserved" = "ready",
      wallet?: string,
      recorded: "known" | "unknown" | "unreachable" = "known",
    ) => {
      const account = await stored(accountId);
      const id = randomUUID();
      if (wallet !== undefined && recorded !== "unreachable")
        boat.seedSnapshot({ name: `sealant-${id.slice(0, 8)}`, wallet });
      await Effect.runPromise(
        db.insert(schema.nativePublications).values({
          id,
          buildId: randomUUID(),
          keyHash: randomUUID(),
          keyPayload: {},
          deploymentId: account.deploymentId,
          scopeKind: "owner",
          scopeId: "seeded",
          recipeHash: "e".repeat(64),
          state,
          boatWalletState: recorded,
          ...(recorded === "known" ? { boatWallet: wallet ?? account.organization } : {}),
          ...(state === "ready"
            ? {
                publication: { snapshot: { identity: { name: `sealant-${id.slice(0, 8)}` } } },
                readyAt: new Date(),
              }
            : {}),
        }),
      );
      return id;
    };
    const reportLaunch = () =>
      run(
        Effect.flatMap(BoatAccountRepo, (repo) =>
          repo.reportLaunch({
            worker: `worker-${randomUUID()}`,
            launches: true,
            defaultAccount: true,
            resourceGateway: true,
            observedAt: new Date(),
          }),
        ),
      );

    it("pins a new personal key at connect to the wallet it bills, and lists the wallets it can bill", async () => {
      const created = await connect("Two organizations");
      expect(created).toMatchObject({
        organization: "team_acme",
        unreachable: null,
        report: {
          organization: "team_acme",
          keyKind: { observed: true, kind: "personal" },
          wallet: { observed: true, kind: "organization", organizationId: "team_acme" },
          wallets: {
            observed: true,
            choices: [
              { id: "personal", kind: "personal", name: "fake-owner", active: false },
              { id: "team_acme", kind: "organization", name: "acme", role: "admin", active: true },
              {
                id: "team_zeta",
                kind: "organization",
                name: "zeta",
                role: "member",
                active: false,
              },
            ],
          },
          billing: { mode: "pinned", organization: "team_acme" },
        },
      });
      expect(await stored(created.boatAccountId)).toMatchObject({
        organization: "team_acme",
        keyKind: "personal",
      });
      // The owner switches the active wallet; the account still names its own on every request.
      boat.account = { ...boat.account, activeWallet: "personal" };
      const from = mark();
      const checked = await run(routes.checkBoatAccount(created.boatAccountId));
      everyRequestNamed(from, "team_acme");
      expect(checked.report?.wallet).toMatchObject({ organizationId: "team_acme" });
      // Named at connect, by name: kept as Boat's id.
      const named = await run(
        routes.createBoatAccount({ label: "Named", apiKey: ACCOUNT_KEY, organization: "zeta" }),
      );
      expect(named.organization).toBe("team_zeta");
      // An organization's key has one wallet: no pin.
      boat.account = { ...boat.account, key: "organization", keyOrganization: "team_acme" };
      const organizationKey = await connect("Organization key");
      expect(organizationKey).toMatchObject({
        organization: null,
        report: { billing: { mode: "key-organization" } },
      });
    });

    it("refuses to connect a key without account.read, naming it: sealant could not see which wallet it bills", async () => {
      boat.account = {
        ...boat.account,
        key: {
          actions: [
            "sandbox.create",
            "sandbox.read",
            "sandbox.stop",
            "sandbox.resume",
            "sandbox.delete",
            "exec",
            "file.write",
            "host",
            "snapshot.read",
            "snapshot.write",
          ],
        },
      };
      const refused = await refusal(
        routes.createBoatAccount({ label: "No account.read", apiKey: ACCOUNT_KEY }),
      );
      expect(refused).toMatchObject({
        _tag: "BoatAccountKeyRefusedError",
        code: "boat-key-missing-permissions",
        missingPermissions: ["account.read"],
      });
      expect(refused.message).toContain("account.read");
      const label = `No account.read`;
      expect((await run(routes.listBoatAccounts())).items.map((item) => item.label)).not.toContain(
        label,
      );
    });

    it("refuses a workspace in the install's own account while its worker reports it cannot launch there, naming account.read", () =>
      withWorkspaceJobTestDatabase(DATABASE_URL ?? "", async (url) => {
        const own = await createSealantDB(url);
        const inOwn = <A, E>(effect: Effect.Effect<A, E, BoatAccountRepo | SealantDB>) =>
          Effect.runPromise(
            effect.pipe(
              Effect.provide(
                BoatAccountRepoLive.pipe(Layer.provideMerge(Layer.succeed(SealantDB, own))),
              ),
              Effect.provideService(availability.BoatConfigured, true),
            ),
          );
        // What a worker with the install's key reports while sealant has not seen its wallet.
        await inOwn(
          Effect.flatMap(BoatAccountRepo, (repo) =>
            repo.reportLaunch({
              worker: `worker-${randomUUID()}`,
              launches: true,
              defaultAccount: false,
              resourceGateway: true,
              observedAt: new Date(),
            }),
          ),
        );
        const refused = await inOwn(
          Effect.flip(availability.requireBoatAccount({ runtime: { resources: "none" } }, "boat")),
        );
        expect(refused).toMatchObject({
          _tag: "WorkspaceServiceUnavailableError",
          code: "boat-account-required",
        });
        expect(refused.message).toContain("account.read");
        expect(refused.message).toContain("SEALANT_BOAT_ORGANIZATION");
      }));

    it("points the account at another wallet at once: images stay recorded where they were made, none deleted first, no workspace refused", async () => {
      const created = await connect("Moves");
      const id = created.boatAccountId;
      const image = await savedImage(id, "ready", "team_acme");
      const moved = await run(routes.setBoatAccountOrganization(id, { organization: "zeta" }));
      expect(moved).toMatchObject({
        organization: "team_zeta",
        report: {
          organization: "team_zeta",
          billing: { mode: "pinned", organization: "team_zeta" },
        },
      });
      expect(await stored(id)).toMatchObject({ organization: "team_zeta", keyRevision: 2 });
      // The image is the old wallet's, recorded there, and still there: the worker removes it there.
      expect(boat.heldIn("team_acme").snapshots).toEqual([imageName(image)]);
      expect(
        await run(
          Effect.flatMap(BoatAccountRepo, (repo) => repo.imagesElsewhere({ accountId: id })),
        ),
      ).toEqual([{ publicationId: image, name: imageName(image), wallet: "team_acme" }]);
      // New workspaces are not refused, and every later request names the new wallet.
      await reportLaunch();
      await run(availability.requireBoatAccount({ runtime: { boatAccountId: id } }, "boat"));
      const from = mark();
      await run(routes.checkBoatAccount(id));
      everyRequestNamed(from, "team_zeta");
      // Back and forth needs no key either.
      const back = await run(routes.setBoatAccountOrganization(id, { organization: "team_acme" }));
      expect(back.organization).toBe("team_acme");
      // Asking for the wallet it names is no change.
      expect(
        await run(routes.setBoatAccountOrganization(id, { organization: "acme" })),
      ).toMatchObject({ organization: "team_acme" });
      expect(await stored(id)).toMatchObject({ keyRevision: 3 });
    });

    it("refuses a change while the account has a run, a run still settling, a build in flight or a full check's leftovers, with the counts, and changes nothing", async () => {
      const created = await connect("Busy");
      const id = created.boatAccountId;
      const change = () => refusal(routes.setBoatAccountOrganization(id, { organization: "zeta" }));

      const live = await liveRun(id);
      const inUse = await change();
      expect(inUse).toMatchObject({
        _tag: "BoatAccountConflictError",
        code: "boat-account-in-use",
        liveRuns: 1,
        unsettledRuns: 0,
        buildsInFlight: 0,
      });
      expect(inUse.message).toContain("1 run whose VM Boat may still hold");
      expect(inUse.message).toContain("nothing was changed");

      // Its VM is gone, and its image pin is not released yet: still being settled.
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* corruptBoatRun(db, live.runId, {
            fencedAt: new Date(),
            deletionClaimedAt: new Date(),
            deletionOperationId: `bdop_${randomUUID().replaceAll("-", "")}`,
            deletionCompletedAt: new Date(),
            absentAt: new Date(),
            absentBasis: "deletion-completed",
          });
          yield* db.insert(schema.nativePublicationConsumers).values({
            runId: live.runId,
            runtimeInstanceId: live.runId,
            publicationId: live.publicationId,
            state: "live",
          });
        }),
      );
      expect(await change()).toMatchObject({
        code: "boat-account-in-use",
        liveRuns: 0,
        unsettledRuns: 1,
      });
      await Effect.runPromise(releaseNativeConsumers(db, live.runId));

      const building = await savedImage(id, "reserved");
      const builds = await change();
      expect(builds).toMatchObject({ code: "boat-account-in-use", buildsInFlight: 1 });
      expect(builds.message).toContain("1 image build in flight or being cleaned up");
      await Effect.runPromise(supersedeNativePublication(db, building));

      // A full check that is still running.
      await Effect.runPromise(
        db.insert(schema.boatKeyProofs).values({
          id: randomUUID(),
          account: id,
          createKey: randomUUID(),
          snapshotName: `sealant-key-proof-${randomUUID().slice(0, 8)}`,
          startedAt: new Date(),
          claimedUntil: new Date(Date.now() + 60_000),
          boatWallet: "team_acme",
          boatWalletState: "known",
        }),
      );
      expect(await change()).toMatchObject({ code: "boat-proof-running" });
      expect(await stored(id)).toMatchObject({ organization: "team_acme", keyRevision: 1 });
    });

    it("refuses no wallet, a wallet the key cannot bill, an organization's key and the install's own key", async () => {
      const created = await connect("Choices");
      const none = await refusal(
        routes.setBoatAccountOrganization(created.boatAccountId, { organization: null }),
      );
      expect(none).toMatchObject({ _tag: "BoatAccountBadRequestError" });
      expect(none.message).toContain("always names the wallet it bills");
      const notMine = await refusal(
        routes.setBoatAccountOrganization(created.boatAccountId, { organization: "team_other" }),
      );
      expect(notMine).toMatchObject({ _tag: "BoatAccountBadRequestError" });
      expect(notMine.message).toContain("personal, team_acme, team_zeta");

      boat.account = { ...boat.account, key: "organization", keyOrganization: "team_acme" };
      const organizationKey = await connect("Organization's");
      for (const organization of ["team_zeta", "team_acme"]) {
        const refused = await refusal(
          routes.setBoatAccountOrganization(organizationKey.boatAccountId, { organization }),
        );
        expect(refused).toMatchObject({ code: "boat-key-organization" });
        expect(refused.message).toContain("there is no wallet to choose");
      }

      const install = await refusal(
        routes.setBoatAccountOrganization("default", { organization: "team_acme" }),
      );
      expect(install).toMatchObject({ code: "boat-account-environment" });
      expect(install.message).toContain("SEALANT_BOAT_ORGANIZATION");
    });

    it("keeps an account connected before pins waiting for the worker, with codes released clients decode", async () => {
      const id = randomUUID();
      await run(
        Effect.flatMap(BoatAccountRepo, (repo) =>
          repo.create({
            id,
            label: "Legacy",
            sealedKey: `sealed:${ACCOUNT_KEY}`,
            keyId: "k-test",
            keyKind: null,
          }),
        ),
      );
      await savedImage(id, "ready", "personal", "unknown");
      const pin = await refusal(
        routes.setBoatAccountOrganization(id, { organization: "personal" }),
      );
      expect(pin).toMatchObject({ code: "boat-account-wallet-unresolved" });
      // Released routes answer a code a client on 0.40.0-next.874 decodes.
      const rotation = await refusal(routes.rotateBoatAccountKey(id, { apiKey: ACCOUNT_KEY }));
      expect(rotation).toMatchObject({ code: "boat-account-in-use" });
      expect(rotation.message).toContain("still finding which Boat wallet");
      const proof = await refusal(routes.proveBoatAccount(id));
      expect(proof).toMatchObject({ code: "boat-account-in-use" });
      const released = Schema.Struct({
        _tag: Schema.Literal("BoatAccountConflictError"),
        message: Schema.String,
        code: Schema.Literals([
          "boat-account-in-use",
          "boat-key-cannot-see",
          "boat-account-removing",
          "boat-account-changed",
          "boat-account-environment",
          "boat-proof-running",
        ]),
      });
      for (const error of [rotation, proof])
        expect(
          Exit.isSuccess(Schema.decodeUnknownExit(released)(JSON.parse(JSON.stringify(error)))),
        ).toBe(true);
      // A workspace naming it is refused with a code, and a sentence that names no id.
      await reportLaunch();
      const create = await refusal(
        availability.requireBoatAccount({ runtime: { boatAccountId: id } }, "boat"),
      );
      expect(create).toMatchObject({
        _tag: "WorkspaceConflictError",
        code: "boat-account-wallet-unresolved",
        message: expect.not.stringContaining(id),
      });
      const releasedWorkspace = Schema.Struct({
        _tag: Schema.Literal("WorkspaceConflictError"),
        message: Schema.String,
        code: Schema.optional(Schema.String),
      });
      expect(
        Exit.isSuccess(
          Schema.decodeUnknownExit(releasedWorkspace)(JSON.parse(JSON.stringify(create))),
        ),
      ).toBe(true);
    });

    it("reports an image Boat has in none of the key's wallets, and lets it block nothing", async () => {
      const created = await connect("Lost image");
      const id = created.boatAccountId;
      const lost = await savedImage(id, "ready", undefined, "unreachable");
      const listed = await run(routes.listBoatAccounts());
      expect(listed.items.find((item) => item.boatAccountId === id)?.unreachable).toEqual({
        savedImages: [imageName(lost)],
      });
      const moved = await run(routes.setBoatAccountOrganization(id, { organization: "personal" }));
      expect(moved).toMatchObject({
        organization: "personal",
        unreachable: { savedImages: [imageName(lost)] },
      });
      await reportLaunch();
      await run(availability.requireBoatAccount({ runtime: { boatAccountId: id } }, "boat"));
      // Never something to remove: not elsewhere, and it does not hold the account's removal.
      expect(
        await run(
          Effect.flatMap(BoatAccountRepo, (repo) => repo.imagesElsewhere({ accountId: id })),
        ),
      ).toEqual([]);
      expect(await run(routes.removeBoatAccount(id))).toMatchObject({ state: "removing" });
      expect(await run(Effect.flatMap(BoatAccountRepo, (repo) => repo.finishRemoval(id)))).toBe(
        "removed",
      );
    });

    it("refuses a rotation to a key that cannot see an image where it was made, and records nothing removed", async () => {
      const created = await connect("Rotating");
      const id = created.boatAccountId;
      const image = await savedImage(id, "ready", "team_acme");
      // The account moved on; its image is still recorded, and held, in team_acme.
      await run(routes.setBoatAccountOrganization(id, { organization: "personal" }));
      const refused = await refusal(routes.rotateBoatAccountKey(id, { apiKey: OTHER_KEY }));
      expect(refused).toMatchObject({ code: "boat-key-cannot-see", unseen: 1 });
      expect(await run(Effect.flatMap(BoatAccountRepo, (repo) => repo.heldImages(id)))).toEqual([
        { name: imageName(image), wallet: "team_acme" },
      ]);
      expect(boat.heldIn("team_acme").snapshots).toEqual([imageName(image)]);
      // The same person's key is read in the image's own wallet, and sees it.
      boat.account = { ...boat.account };
      const rotated = await run(routes.rotateBoatAccountKey(id, { apiKey: ACCOUNT_KEY }));
      expect(rotated.keyRotatedAt).not.toBeNull();
      expect(boat.organizationHeaders).toContainEqual({
        method: "GET",
        path: `/saved-snapshots/${imageName(image)}`,
        organization: "team_acme",
      });
    });

    it("keeps list() and the report decodable by the released contract (0.40.0-next.874)", async () => {
      const created = await connect("Released");
      await savedImage(created.boatAccountId, "ready", undefined, "unreachable");
      await run(
        routes.setBoatAccountOrganization(created.boatAccountId, { organization: "personal" }),
      );
      const listed = await run(routes.listBoatAccounts());
      const notObserved = Schema.Struct({
        observed: Schema.Literal(false),
        reason: Schema.Literals(["refused", "no-answer", "not-listed", "unreadable"]),
      });
      const fact = <F extends Schema.Struct.Fields>(fields: F) =>
        Schema.Union([Schema.Struct({ observed: Schema.Literal(true), ...fields }), notObserved]);
      const releasedReport = Schema.Struct({
        observedAt: Schema.String,
        organization: Schema.NullOr(Schema.String),
        identity: fact({
          accountStatus: Schema.Literals(["active", "suspended", "closed", "unknown"]),
        }),
        keyKind: fact({ kind: Schema.Literals(["personal", "organization"]) }),
        wallet: fact({
          kind: Schema.Literals(["personal", "organization"]),
          organizationId: Schema.optional(Schema.String),
        }),
        requiredPermissions: Schema.Array(Schema.String),
        permissions: fact({
          held: Schema.Array(Schema.String),
          missing: Schema.Array(Schema.String),
          limitedToSandboxes: Schema.Boolean,
        }),
        expiry: fact({ expiresAt: Schema.NullOr(Schema.String), expired: Schema.Boolean }),
        start: fact({ canStart: Schema.Boolean, runningVms: Schema.Int, allowedVms: Schema.Int }),
        snapshots: fact({ used: Schema.Int, included: Schema.Int }),
      });
      const released = Schema.Struct({
        items: Schema.Array(
          Schema.Struct({
            boatAccountId: Schema.String.check(
              Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
            ),
            label: Schema.String,
            state: Schema.Literals(["active", "removing"]),
            createdAt: Schema.String,
            keyRotatedAt: Schema.NullOr(Schema.String),
            organization: Schema.optional(Schema.NullOr(Schema.String)),
            report: Schema.optional(Schema.NullOr(releasedReport)),
          }),
        ),
      });
      const wire: unknown = JSON.parse(JSON.stringify(listed));
      expect(Exit.isSuccess(Schema.decodeUnknownExit(released)(wire))).toBe(true);
      expect(
        listed.items.find((item) => item.boatAccountId === created.boatAccountId),
      ).toMatchObject({
        organization: "personal",
        unreachable: { savedImages: expect.any(Array) },
        report: { wallets: { observed: true }, billing: { mode: "pinned" } },
      });
    });
  },
);
