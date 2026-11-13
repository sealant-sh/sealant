/**
 * An install with no Boat key in its environment (SLNT-783), against the fake Boat through the
 * routes: a stored account is created, checked, used for a Boat create, rotated and removed. And
 * the create's answer is the worker's: a Boat create no worker could serve is refused at create,
 * with the sentence that says who can change it, and accepted once a worker says it launches.
 */
import { randomUUID } from "node:crypto";

import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
  BoatAccountRepo,
  BoatAccountRepoLive,
  createSealantDB,
  SealantDB,
  type DB,
} from "@sealant/db";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import { HttpBoatApi } from "@sealant/workspaces";
import { FakeBoat } from "@sealant/workspaces/testing/fake-boat";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");
delete process.env["SEALANT_BOAT_API_KEY"];
delete process.env["SEALANT_BOAT_API_KEY_FILE"];

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
/** Fixture keys only: two keys of the one fake Boat account. */
const ACCOUNT_KEY = "boat_live_fixture_stored_key_0003";
const ROTATED_KEY = "boat_live_fixture_rotated_key_0004";

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

describe.skipIf(DATABASE_URL === undefined)(
  "Boat from stored keys alone (Postgres, fake Boat)",
  () => {
    let db: DB;
    const boat = new FakeBoat({
      runId: "stored01",
      credential: ACCOUNT_KEY,
      otherCredentials: [ROTATED_KEY],
      network: "unit",
      baseImage: "unit-base",
      docker,
    });

    beforeAll(async () => {
      routes = await import("./boat-accounts.module.js");
      availability = await import("../../services/boat-availability.js");
      await boat.start();
    });
    afterAll(async () => {
      await boat.stop();
    });

    /** Each case on a database of its own: the workers' reports are the install's, not the suite's. */
    const fresh = (body: () => Promise<void>) => () =>
      withWorkspaceJobTestDatabase(DATABASE_URL ?? "", async (url) => {
        db = await createSealantDB(url);
        await body();
      });

    // Nothing is overridden but how a key reaches Boat: the install's own key is the env's (none),
    // and whether Boat launches is what the workers reported.
    const run = <A, E>(
      effect: Effect.Effect<A, E, BoatAccountRepo | CredentialCipher | SealantDB>,
    ) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            BoatAccountRepoLive.pipe(
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
      effect: Effect.Effect<A, E, BoatAccountRepo | CredentialCipher | SealantDB>,
    ) => run(Effect.flip(effect));
    const report = (input: {
      readonly worker: string;
      readonly launches: boolean;
      readonly defaultAccount?: boolean;
      readonly resourceGateway?: boolean;
      readonly observedAt?: Date;
    }) =>
      run(
        Effect.flatMap(BoatAccountRepo, (repo) =>
          repo.reportLaunch({
            defaultAccount: false,
            resourceGateway: false,
            observedAt: new Date(),
            ...input,
          }),
        ),
      );
    /** What the create route checks of a Boat spec, in its order, before anything is reserved. */
    const boatCreate = (runtime: {
      readonly boatAccountId?: string;
      readonly resources?: string;
    }) =>
      Effect.gen(function* () {
        yield* availability.requireBoatConfigured;
        yield* availability.requireBoatAccount({ runtime }, "boat");
      });

    it(
      "refuses a Boat create at create while no worker launches Boat, and says who can change it",
      fresh(async () => {
        // No worker has reported: nobody would serve the create.
        const none = await refusal(boatCreate({ resources: "none" }));
        expect(none).toMatchObject({
          _tag: "WorkspaceServiceUnavailableError",
          code: "unsupported-runtime",
        });
        expect(none.message).toContain("No worker of this install has reported launching Boat");
        expect(none.message).toContain("operator");
        // A worker that runs without Boat's state directory.
        await report({ worker: `w-${randomUUID()}`, launches: false });
        const off = await refusal(boatCreate({ resources: "none" }));
        expect(off.message).toContain("SEALANT_BOAT_STATE_DIRECTORY is not set");
        expect(await run(availability.boatLaunchable)).toBe(false);
      }),
    );

    it(
      "runs a stored account end to end with no Boat key in the environment",
      fresh(async () => {
        // The worker launches, from stored accounts only, without the gateway.
        await report({ worker: `w-${randomUUID()}`, launches: true });
        // Launching, but no account yet: still refused, and the sentence says how to add one.
        const noAccount = await refusal(boatCreate({ resources: "none" }));
        expect(noAccount.message).toContain("stores no Boat account");

        const created = await run(
          routes.createBoatAccount({ label: "Org S", apiKey: ACCOUNT_KEY }),
        );
        expect(created).toMatchObject({ state: "active" });
        expect(created.report?.identity).toMatchObject({ observed: true });
        expect(await run(availability.boatLaunchable)).toBe(true);

        const listed = await run(routes.listBoatAccounts());
        expect(listed.items.map((item) => item.boatAccountId)).toContain(created.boatAccountId);

        const checked = await run(routes.checkBoatAccount(created.boatAccountId));
        expect(checked.report?.observedAt).toBeDefined();
        // The install has no key of its own to check.
        expect(await refusal(routes.checkBoatInstallKey())).toMatchObject({
          _tag: "BoatAccountServiceUnavailableError",
          message: expect.stringContaining("no Boat key of its own"),
        });
        expect(await refusal(routes.getBoatInstallKey())).toMatchObject({
          _tag: "BoatAccountServiceUnavailableError",
        });

        // A create that names the account is accepted; one that names none is refused, since no
        // worker has the install's own key; one that reaches resources is refused for the gateway.
        await run(boatCreate({ boatAccountId: created.boatAccountId, resources: "none" }));
        const unnamed = await refusal(boatCreate({ resources: "none" }));
        expect(unnamed).toMatchObject({ code: "boat-account-required" });
        expect(unnamed.message).toContain("must name a stored Boat account");
        const resources = await refusal(boatCreate({ boatAccountId: created.boatAccountId }));
        expect(resources).toMatchObject({ code: "gateway-unavailable" });
        expect(resources.message).toContain('runtime.resources: "none"');

        const rotated = await run(
          routes.rotateBoatAccountKey(created.boatAccountId, { apiKey: ROTATED_KEY }),
        );
        expect(rotated.keyRotatedAt).not.toBeNull();
        const sealed = await run(
          Effect.flatMap(BoatAccountRepo, (repo) => repo.sealedKey(created.boatAccountId)),
        );
        expect(sealed?.sealedKey).toBe(`sealed:${ROTATED_KEY}`);

        const removing = await run(routes.removeBoatAccount(created.boatAccountId));
        expect(removing).toMatchObject({ state: "removing" });
        // Its only account going away, the install has none left to run a Boat workspace in.
        const gone = await refusal(
          boatCreate({ boatAccountId: created.boatAccountId, resources: "none" }),
        );
        expect(gone.message).toContain("stores no Boat account");
      }),
    );

    it(
      "counts only workers that reported in the last five minutes",
      fresh(async () => {
        const longAgo = new Date(Date.now() - 10 * 60_000);
        // Only an old report says a worker launches: it is not counted.
        await report({
          worker: `w-${randomUUID()}`,
          launches: true,
          defaultAccount: true,
          observedAt: longAgo,
        });
        const refused = await refusal(boatCreate({ resources: "none" }));
        expect(refused).toMatchObject({ code: "unsupported-runtime" });
        expect(refused.message).toContain("in the last five minutes");
        await report({
          worker: `w-${randomUUID()}`,
          launches: true,
          defaultAccount: true,
          resourceGateway: true,
        });
        await run(boatCreate({}));
      }),
    );
  },
);
