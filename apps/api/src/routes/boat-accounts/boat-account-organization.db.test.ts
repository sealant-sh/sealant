/**
 * A stored account pointed at the wallet it bills after it was connected, through the
 * routes, against the fake Boat (which keeps each wallet's VMs and snapshots apart): the report
 * lists the wallets a personal key can bill and says whether the account is pinned; a pin, a
 * re-pin and an unpin need no key; a pin to the personal wallet holds when the active wallet
 * moves; an unpinned key's report says when its wallet moved; and a change is refused, with the
 * counts, while the account has anything in Boat but saved images, and waits on those.
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
  markNativePublicationRemoved,
  releaseNativeConsumers,
  supersedeNativePublication,
} from "@sealant/db/testing/native-publications";
import { BoatSecret, HttpBoatApi } from "@sealant/workspaces";
import { FakeBoat } from "@sealant/workspaces/testing/fake-boat";
import { Effect, Exit, Layer, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
/** Fixture keys only: the fake Boat accepts the account key; the install key is another. */
const ACCOUNT_KEY = "boat_live_fixture_wallet_key_0005";
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

    beforeAll(async () => {
      routes = await import("./boat-accounts.module.js");
      availability = await import("../../services/boat-availability.js");
      db = await createSealantDB(DATABASE_URL ?? "");
      await boat.start();
    });
    afterAll(async () => {
      await boat.stop();
    });
    beforeEach(() => {
      boat.account = { orgs: TWO_ORGANIZATIONS, activeWallet: "team_acme" };
      boat.faults = {};
      boat.organizationHeaders.length = 0;
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
              baseUrl: boat.baseUrl,
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
    /** A saved image Core built in the account, ready: what retention and removal delete. */
    const savedImage = async (accountId: string, state: "ready" | "reserved" = "ready") => {
      const account = await stored(accountId);
      const id = randomUUID();
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
    const dropImage = (id: string) => Effect.runPromise(markNativePublicationRemoved(db, id));

    it("lists the wallets a personal key in two organizations can bill, the active one marked, and says it is not pinned", async () => {
      const created = await connect("Two organizations");
      expect(created).toMatchObject({
        organization: null,
        organizationChange: null,
        report: {
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
          billing: { mode: "active-wallet" },
        },
      });
      // Unpinned: no request named a wallet.
      expect(boat.organizationHeaders).toEqual([]);
    });

    it("pins an account that holds nothing at once, by an organization's name, and names its id on every later request", async () => {
      const created = await connect("Pinned later");
      const pinned = await run(
        routes.setBoatAccountOrganization(created.boatAccountId, { organization: "zeta" }),
      );
      // Kept by the id Boat answered, never the name.
      expect(pinned).toMatchObject({
        organization: "team_zeta",
        organizationChange: null,
        report: {
          organization: "team_zeta",
          wallet: { observed: true, kind: "organization", organizationId: "team_zeta" },
          billing: { mode: "pinned", organization: "team_zeta" },
        },
      });
      const account = await stored(created.boatAccountId);
      expect(account).toMatchObject({ organization: "team_zeta", keyRevision: 2 });
      // The check, its limits read and every other read name it; so does the client the worker
      // opens for the account (`account-organization.db.test.ts`, `boat-wallet-change.db.test.ts`).
      const from = mark();
      await run(routes.checkBoatAccount(created.boatAccountId));
      everyRequestNamed(from, "team_zeta");
      expect(boat.organizationHeaders).toContainEqual({
        method: "GET",
        path: "/limits",
        organization: "team_zeta",
      });
      expect(boat.organizationHeaders).toContainEqual({
        method: "GET",
        path: "/saved-snapshots",
        organization: "team_zeta",
      });
      // The key was never asked for again, and is in no answer.
      expect(JSON.stringify(pinned)).not.toContain(ACCOUNT_KEY);
      const listed = await run(routes.listBoatAccounts());
      expect(
        listed.items.find((item) => item.boatAccountId === created.boatAccountId),
      ).toMatchObject({ organization: "team_zeta", organizationChange: null });
    });

    it("keeps billing the personal wallet when pinned to it, after the active wallet is switched", async () => {
      const created = await connect("Personal");
      await run(
        routes.setBoatAccountOrganization(created.boatAccountId, { organization: "personal" }),
      );
      boat.account = { ...boat.account, activeWallet: "team_zeta" };
      const checked = await run(routes.checkBoatAccount(created.boatAccountId));
      expect(checked).toMatchObject({
        organization: "personal",
        report: {
          wallet: { observed: true, kind: "personal" },
          billing: { mode: "pinned", organization: "personal" },
        },
      });
    });

    it("says an unpinned key's wallet changed after its active wallet is switched, and unpins", async () => {
      const created = await connect("Follows");
      const pinned = await run(
        routes.setBoatAccountOrganization(created.boatAccountId, { organization: "team_acme" }),
      );
      expect(pinned.organization).toBe("team_acme");
      const unpinned = await run(
        routes.setBoatAccountOrganization(created.boatAccountId, { organization: null }),
      );
      expect(unpinned).toMatchObject({
        organization: null,
        report: { billing: { mode: "active-wallet" } },
      });
      expect(unpinned.report?.billing).not.toHaveProperty("walletChanged");
      boat.account = { ...boat.account, activeWallet: "personal" };
      const checked = await run(routes.checkBoatAccount(created.boatAccountId));
      expect(checked.report).toMatchObject({
        wallet: { observed: true, kind: "personal" },
        billing: {
          mode: "active-wallet",
          walletChanged: {
            from: { kind: "organization", organizationId: "team_acme" },
            observedAt: checked.report?.observedAt,
          },
        },
      });
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
        }),
      );
      expect(await change()).toMatchObject({ code: "boat-proof-running" });
      expect(await stored(id)).toMatchObject({ organization: null, organizationChange: null });
    });

    it("with only saved images, waits for them to be deleted from the old wallet, refuses new workspaces meanwhile, and can be called off", async () => {
      const created = await connect("Images");
      const id = created.boatAccountId;
      const image = await savedImage(id);
      const pending = await run(routes.setBoatAccountOrganization(id, { organization: "zeta" }));
      // Not switched yet: it still bills the old wallet, and the report still says so.
      expect(pending).toMatchObject({
        organization: null,
        organizationChange: { organization: "team_zeta", imagesLeft: 1 },
        report: { organization: null, billing: { mode: "active-wallet" } },
      });
      expect(pending.organizationChange?.requestedAt).toEqual(expect.any(String));
      const listed = await run(routes.listBoatAccounts());
      expect(listed.items.find((item) => item.boatAccountId === id)?.organizationChange).toEqual(
        pending.organizationChange,
      );
      // No new workspace runs in it while its images are being deleted.
      await run(
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
      expect(
        await refusal(availability.requireBoatAccount({ runtime: { boatAccountId: id } }, "boat")),
      ).toMatchObject({ _tag: "WorkspaceConflictError" });
      // Nor does a full check, whose VM and snapshot would be the old wallet's.
      expect(await refusal(routes.proveBoatAccount(id))).toMatchObject({
        code: "boat-account-in-use",
      });
      // The worker's pass finishes once they are gone (`boat-wallet-change.db.test.ts`); here, the
      // same statement it ends with.
      await dropImage(image);
      expect(
        await run(Effect.flatMap(BoatAccountRepo, (repo) => repo.finishOrganizationChange(id))),
      ).toBe("changed");
      expect(await stored(id)).toMatchObject({
        organization: "team_zeta",
        organizationChange: null,
        keyRevision: 2,
      });

      // Called off: asking for the organization it bills ends an unfinished change.
      await savedImage(id);
      const again = await run(routes.setBoatAccountOrganization(id, { organization: null }));
      expect(again.organizationChange).toMatchObject({ organization: null, imagesLeft: 1 });
      const off = await run(routes.setBoatAccountOrganization(id, { organization: "team_zeta" }));
      expect(off).toMatchObject({ organization: "team_zeta", organizationChange: null });
      // A removal calls one off too: the images are deleted from the wallet it bills.
      await run(routes.setBoatAccountOrganization(id, { organization: "personal" }));
      const removing = await run(routes.removeBoatAccount(id));
      expect(removing).toMatchObject({ state: "removing", organizationChange: null });
    });

    it("refuses a wallet the key's account cannot bill, an organization's key, and the install's own key", async () => {
      const created = await connect("Choices");
      const notMine = await refusal(
        routes.setBoatAccountOrganization(created.boatAccountId, { organization: "team_other" }),
      );
      expect(notMine).toMatchObject({ _tag: "BoatAccountBadRequestError" });
      expect(notMine.message).toContain("personal, team_acme, team_zeta");

      // The key is an organization's: it bills that organization, and nothing else.
      boat.account = { ...boat.account, key: "organization", keyOrganization: "team_acme" };
      for (const organization of ["team_zeta", "team_acme", null]) {
        const refused = await refusal(
          routes.setBoatAccountOrganization(created.boatAccountId, { organization }),
        );
        expect(refused).toMatchObject({
          _tag: "BoatAccountConflictError",
          code: "boat-key-organization",
        });
        expect(refused.message).toContain("there is no wallet to choose");
      }
      const checked = await run(routes.checkBoatAccount(created.boatAccountId));
      expect(checked.report?.billing).toEqual({ mode: "key-organization" });
      expect((await stored(created.boatAccountId)).organization).toBeNull();

      // The install's own key: set in its environment, with SEALANT_BOAT_ORGANIZATION.
      const install = await refusal(
        routes.setBoatAccountOrganization("default", { organization: "team_acme" }),
      );
      expect(install).toMatchObject({ code: "boat-account-environment" });
      expect(install.message).toContain("SEALANT_BOAT_ORGANIZATION");
    });

    it("keeps list() and the report decodable by the released contract (0.40.0-next.874)", async () => {
      const created = await connect("Released");
      await run(routes.setBoatAccountOrganization(created.boatAccountId, { organization: "acme" }));
      await savedImage(created.boatAccountId);
      await run(routes.setBoatAccountOrganization(created.boatAccountId, { organization: null }));
      const listed = await run(routes.listBoatAccounts());
      // The account and its report as @sealant/api-contracts-next@0.40.0-next.874 ships them.
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
      const decoded = Schema.decodeUnknownExit(released)(wire);
      expect(Exit.isSuccess(decoded)).toBe(true);
      const mine = listed.items.find((item) => item.boatAccountId === created.boatAccountId);
      expect(mine).toMatchObject({
        organization: "team_acme",
        organizationChange: { organization: null, imagesLeft: 1 },
        report: { wallets: { observed: true }, billing: { mode: "pinned" } },
      });
    });

    it("asks Boat again for a wallet its last report did not list: an organization joined since", async () => {
      const created = await connect("Joined later");
      boat.account = {
        ...boat.account,
        orgs: [
          ...TWO_ORGANIZATIONS,
          { id: "team_new", name: "new", type: "org", role: "member", active: false },
        ],
      };
      const pinned = await run(
        routes.setBoatAccountOrganization(created.boatAccountId, { organization: "new" }),
      );
      expect(pinned).toMatchObject({
        organization: "team_new",
        report: {
          wallets: {
            observed: true,
            choices: expect.arrayContaining([expect.objectContaining({ id: "team_new" })]),
          },
        },
      });
    });

    it("relabels an organization stored by its name to its id without deleting the images it holds there", async () => {
      const created = await run(
        routes.createBoatAccount({ label: "By name", apiKey: ACCOUNT_KEY, organization: "acme" }),
      );
      expect(created.organization).toBe("acme");
      const image = await savedImage(created.boatAccountId);
      const relabelled = await run(
        routes.setBoatAccountOrganization(created.boatAccountId, { organization: "team_acme" }),
      );
      // The same wallet: switched at once, its image kept.
      expect(relabelled).toMatchObject({ organization: "team_acme", organizationChange: null });
      expect(
        await run(
          Effect.flatMap(BoatAccountRepo, (repo) => repo.heldImages(created.boatAccountId)),
        ),
      ).toEqual([`sealant-${image.slice(0, 8)}`]);
    });
  },
);
