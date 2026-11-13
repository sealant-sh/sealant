/**
 * Boat keys checked against the fake Boat through the routes (SLNT-781): the report a stored
 * account keeps, the refusal of a key that lacks a permission, an organization the account names
 * on every request, trimmed keys, and the install's own key in `list` and `check`, which rotation
 * and removal refuse.
 */
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
import { BoatSecret, HttpBoatApi } from "@sealant/workspaces";
import { FakeBoat } from "@sealant/workspaces/testing/fake-boat";
import { Effect, Exit, Layer, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
/** Fixture keys only: the fake Boat accepts the account key; the install key is another. */
const ACCOUNT_KEY = "boat_live_fixture_account_key_0001";
const INSTALL_KEY = "boat_live_fixture_install_key_0002";

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

describe.skipIf(DATABASE_URL === undefined)("Boat key reports (Postgres, fake Boat)", () => {
  let db: DB;
  const account = new FakeBoat({
    runId: "keyrpt01",
    credential: ACCOUNT_KEY,
    network: "unit",
    baseImage: "unit-base",
    docker,
  });
  const install = new FakeBoat({
    runId: "keyrpt02",
    credential: INSTALL_KEY,
    network: "unit",
    baseImage: "unit-base",
    docker,
  });
  /** The organizations each opened client named, in order. */
  const opened: Array<string | undefined> = [];

  beforeAll(async () => {
    routes = await import("./boat-accounts.module.js");
    availability = await import("../../services/boat-availability.js");
    db = await createSealantDB(DATABASE_URL ?? "");
    await Promise.all([account.start(), install.start()]);
  });
  afterAll(async () => {
    await Promise.all([account.stop(), install.stop()]);
  });
  beforeEach(() => {
    account.account = {};
    account.faults = {};
    account.organizationHeaders.length = 0;
  });

  const run = <A, E>(
    effect: Effect.Effect<A, E, BoatAccountRepo | BoatKeyProofRepo | CredentialCipher | SealantDB>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.merge(BoatAccountRepoLive, BoatKeyProofRepoLive).pipe(
            Layer.provideMerge(Layer.succeed(SealantDB, db)),
            Layer.provideMerge(Layer.succeed(CredentialCipher, cipher)),
          ),
        ),
        Effect.provideService(availability.BoatConfigured, true),
        Effect.provideService(availability.BoatDefaultKey, () => BoatSecret.parse(INSTALL_KEY)),
        Effect.provideService(availability.BoatKeyClients, (credential, options) => {
          opened.push(options?.organization);
          return HttpBoatApi.create({
            credential,
            baseUrl: credential.reveal() === INSTALL_KEY ? install.baseUrl : account.baseUrl,
            timeoutMs: 5_000,
            ...(options?.organization === undefined ? {} : { organization: options.organization }),
          });
        }),
      ),
    );
  const refusal = <A, E>(
    effect: Effect.Effect<A, E, BoatAccountRepo | BoatKeyProofRepo | CredentialCipher | SealantDB>,
  ) => run(Effect.flip(effect));

  it("stores a trimmed key with its report, and list shows it with when it was observed", async () => {
    account.account = { allowance: { used: 7, included: 10 } };
    const created = await run(
      routes.createBoatAccount({ label: "Org A", apiKey: `  ${ACCOUNT_KEY}\n` }),
    );
    expect(created).toMatchObject({
      // Pinned at connect to the wallet the key bills.
      organization: "personal",
      report: {
        identity: { observed: true, login: "fake-owner", accountStatus: "active" },
        wallet: { observed: true, kind: "personal" },
        permissions: { observed: true, held: ["*"], missing: [] },
        start: { observed: true, canStart: true, runningVms: 0, allowedVms: 2 },
        snapshots: { observed: true, used: 7, included: 10 },
      },
    });
    // Sealed without the whitespace it was pasted with.
    expect(
      await run(Effect.flatMap(BoatAccountRepo, (repo) => repo.sealedKey(created.boatAccountId))),
    ).toMatchObject({ sealedKey: `sealed:${ACCOUNT_KEY}` });
    const listed = await run(routes.listBoatAccounts());
    const mine = listed.items.find((item) => item.boatAccountId === created.boatAccountId);
    expect(mine?.report).toEqual(created.report);
    expect(mine?.report?.observedAt).toEqual(expect.any(String));
    expect(JSON.stringify(listed)).not.toContain(ACCOUNT_KEY);
    expect(JSON.stringify(listed)).not.toContain(INSTALL_KEY);
  });

  it("refuses a key that lacks a permission Core needs, naming it, and stores nothing", async () => {
    account.account = {
      key: {
        actions: [
          "sandbox.create",
          "sandbox.read",
          "sandbox.stop",
          "sandbox.resume",
          "sandbox.delete-own",
          "exec",
          "file.write",
          "host",
          "snapshot.read",
          "snapshot.write",
        ],
      },
    };
    const refused = await refusal(
      routes.createBoatAccount({ label: "Missing delete", apiKey: ACCOUNT_KEY }),
    );
    expect(refused).toMatchObject({
      _tag: "BoatAccountKeyRefusedError",
      code: "boat-key-missing-permissions",
      missingPermissions: ["sandbox.delete"],
      report: { permissions: { observed: true, missing: ["sandbox.delete"] } },
    });
    expect(refused.message).toContain("sandbox.delete");
    expect(JSON.stringify(refused)).not.toContain(ACCOUNT_KEY);
    const listed = await run(routes.listBoatAccounts());
    expect(listed.items.map((item) => item.label)).not.toContain("Missing delete");
  });

  it("refuses an expired key with Boat's reason", async () => {
    account.faults = {
      refuse: () => ({ status: 403, code: "api_key_expired", message: "API key expired." }),
    };
    expect(
      await refusal(routes.createBoatAccount({ label: "Expired", apiKey: ACCOUNT_KEY })),
    ).toMatchObject({
      code: "boat-key-refused",
      boat: { kind: "key-expired", code: "api_key_expired" },
    });
  });

  it("stores an organization key Boat refuses the key list, its permissions not observed", async () => {
    account.account = { key: "organization" };
    const created = await run(routes.createBoatAccount({ label: "Org key", apiKey: ACCOUNT_KEY }));
    expect(created.report).toMatchObject({
      keyKind: { observed: true, kind: "organization" },
      permissions: { observed: false, reason: "refused" },
    });
  });

  it("names the organization a personal key bills on every request for the account", async () => {
    opened.length = 0;
    const created = await run(
      routes.createBoatAccount({ label: "Pinned", apiKey: ACCOUNT_KEY, organization: "team_acme" }),
    );
    expect(created).toMatchObject({
      organization: "team_acme",
      report: {
        organization: "team_acme",
        wallet: { observed: true, kind: "organization", organizationId: "team_acme" },
      },
    });
    expect(account.organizationHeaders).toContainEqual({
      method: "GET",
      path: "/limits",
      organization: "team_acme",
    });
    // Stored, and named again by the account's re-check and by the worker's client.
    expect(
      await run(Effect.flatMap(BoatAccountRepo, (repo) => repo.sealedKey(created.boatAccountId))),
    ).toMatchObject({ organization: "team_acme" });
    await run(routes.checkBoatAccount(created.boatAccountId));
    expect(opened).toEqual(["team_acme", "team_acme"]);
  });

  it("keeps list() decodable by the released SDK (0.40.0-next.868)", async () => {
    await run(routes.createBoatAccount({ label: "Decodable", apiKey: ACCOUNT_KEY }));
    const listed = await run(routes.listBoatAccounts());
    expect(listed.items.length).toBeGreaterThan(0);
    // The released contract's account, as @sealant/api-contracts-next@0.40.0-next.868 ships it:
    // a UUID-only id. Its decode ignores the fields added since.
    const released = Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          boatAccountId: Schema.String.check(
            Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
          ),
          label: Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed()),
          state: Schema.Literals(["active", "removing"]),
          createdAt: Schema.String,
          keyRotatedAt: Schema.NullOr(Schema.String),
        }),
      ),
    });
    const wire: unknown = JSON.parse(JSON.stringify(listed));
    expect(Exit.isSuccess(Schema.decodeUnknownExit(released)(wire))).toBe(true);
  });

  it("reads and checks the install's own key apart from list(), and refuses to rotate or remove it", async () => {
    const before = await run(routes.listBoatAccounts());
    expect(before.items.map((item) => item.boatAccountId)).not.toContain("default");
    const checked = await run(routes.checkBoatInstallKey());
    expect(checked).toMatchObject({
      report: { identity: { observed: true }, permissions: { observed: true, missing: [] } },
    });
    expect(await run(routes.getBoatInstallKey())).toEqual(checked);
    expect(JSON.stringify(checked)).not.toContain(INSTALL_KEY);
    expect(
      await refusal(routes.rotateBoatAccountKey("default", { apiKey: ACCOUNT_KEY })),
    ).toMatchObject({ _tag: "BoatAccountConflictError", code: "boat-account-environment" });
    expect(await refusal(routes.removeBoatAccount("default"))).toMatchObject({
      _tag: "BoatAccountConflictError",
      code: "boat-account-environment",
    });
  });

  it("re-checks a stored key Boat now refuses: reported, not refused", async () => {
    const created = await run(routes.createBoatAccount({ label: "Lapsing", apiKey: ACCOUNT_KEY }));
    account.faults = {
      refuse: () => ({ status: 403, code: "api_key_expired", message: "API key expired." }),
    };
    const checked = await run(routes.checkBoatAccount(created.boatAccountId));
    expect(checked.report).toMatchObject({
      identity: { observed: false, reason: "refused", boat: { kind: "key-expired" } },
    });
    account.faults = { refuse: () => "no-answer" };
    expect(await refusal(routes.checkBoatAccount(created.boatAccountId))).toMatchObject({
      code: "boat-key-unverified",
    });
    // A rate limit says nothing about the key either (SLNT-781 review).
    account.faults = {
      refuse: () => ({
        status: 429,
        code: "rate_limited",
        fields: { retryAfterSeconds: 30 },
        retryAfter: 30,
      }),
    };
    expect(await refusal(routes.checkBoatAccount(created.boatAccountId))).toMatchObject({
      code: "boat-key-unverified",
      boat: { kind: "rate-limited", retryAfterSeconds: 30 },
    });
    // The last report stands.
    const listed = await run(routes.listBoatAccounts());
    expect(
      listed.items.find((item) => item.boatAccountId === created.boatAccountId)?.report,
    ).toEqual(checked.report);
  });
});
