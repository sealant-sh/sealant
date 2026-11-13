/**
 * The scheduled refresh of Boat key reports (SLNT-783), against the fake Boat with an injected
 * clock: a report a day old is checked again and replaced, a recent one is left, the install's own
 * key is checked when asked whatever its age (the worker's start), a key Boat now refuses is
 * reported as refused, and a check Boat does not answer keeps the last report.
 */
import { randomUUID } from "node:crypto";

import type { CredentialCipherService } from "@sealant/credentials";
import {
  BoatAccountRepo,
  BoatAccountRepoLive,
  SealantDB,
  createSealantDB,
  type DB,
} from "@sealant/db";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { FakeBoat } from "../../../boat-harness/fake-boat.js";
import { BOAT_REFUSALS } from "../../../boat-harness/refusals.js";
import { HttpBoatApi } from "./api.js";
import { BoatSecret } from "./config.js";
import { BOAT_KEY_REFRESH_MS, refreshBoatKeyReports } from "./key-refresh.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
const ACCOUNT_KEY = "boat_live_fixture_refresh_key_0005";
const INSTALL_KEY = "boat_live_fixture_install_key_0006";
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

describe.skipIf(databaseUrl === undefined)("the scheduled refresh of Boat key reports", () => {
  it("replaces day-old reports, leaves recent ones, and keeps the last when Boat does not answer", () =>
    withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
      const account = new FakeBoat({
        runId: "refresh1",
        credential: ACCOUNT_KEY,
        network: "unit",
        baseImage: "unit-base",
        docker,
      });
      const install = new FakeBoat({
        runId: "refresh2",
        credential: INSTALL_KEY,
        network: "unit",
        baseImage: "unit-base",
        docker,
      });
      await Promise.all([account.start(), install.start()]);
      const db: DB = await createSealantDB(url);
      const repo = <A, E>(effect: Effect.Effect<A, E, BoatAccountRepo>) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provide(BoatAccountRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db)))),
          ),
        );
      try {
        const id = randomUUID();
        await repo(
          Effect.flatMap(BoatAccountRepo, (accounts) =>
            accounts.create({ id, label: "Org R", sealedKey: `sealed:${ACCOUNT_KEY}`, keyId: "k" }),
          ),
        );
        const installKey = BoatSecret.parse(INSTALL_KEY);
        if (!installKey.ok) throw installKey.error;
        let clock = new Date("2026-11-13T08:00:00.000Z");
        const options = {
          db,
          cipher,
          defaultKey: { credential: installKey.value, organization: "team_acme" },
          clientFor: (credential: BoatSecret, opened?: { readonly organization?: string }) =>
            HttpBoatApi.create({
              credential,
              baseUrl: credential.reveal() === INSTALL_KEY ? install.baseUrl : account.baseUrl,
              timeoutMs: 5_000,
              ...(opened?.organization === undefined ? {} : { organization: opened.organization }),
            }),
          now: () => clock,
        };
        const reports = () => repo(Effect.flatMap(BoatAccountRepo, (store) => store.reports()));

        // No report yet: both keys are checked, and the install's own names its organization.
        expect(await refreshBoatKeyReports(options)).toEqual([
          { account: "default", outcome: "refreshed" },
          { account: id, outcome: "refreshed" },
        ]);
        const first = await reports();
        expect(first.get(id)?.observedAt.toISOString()).toBe(clock.toISOString());
        // The install's own key, pinned by SEALANT_BOAT_ORGANIZATION, says so as a stored one does.
        expect(first.get("default")?.report).toMatchObject({
          organization: "team_acme",
          billing: { mode: "pinned", organization: "team_acme" },
        });
        expect(first.get(id)?.report).toMatchObject({ billing: { mode: "active-wallet" } });
        expect(install.organizationHeaders.map((header) => header.organization)).toContain(
          "team_acme",
        );

        // An hour later nothing is due; the install's own key is checked when asked (worker start).
        clock = new Date(clock.getTime() + 3_600_000);
        expect(await refreshBoatKeyReports(options, { force: ["default"] })).toEqual([
          { account: "default", outcome: "refreshed" },
          { account: id, outcome: "fresh" },
        ]);

        // A day later Boat suspends the account: the report says so.
        clock = new Date(clock.getTime() + BOAT_KEY_REFRESH_MS);
        account.account = { suspended: true };
        await refreshBoatKeyReports(options);
        const suspended = await reports();
        expect(suspended.get(id)?.observedAt.toISOString()).toBe(clock.toISOString());
        expect(suspended.get(id)?.report).toMatchObject({
          identity: { observed: true, accountStatus: "suspended" },
        });
        account.account = {};

        // A day later again Boat does not answer for the stored key: its last report stays.
        clock = new Date(clock.getTime() + BOAT_KEY_REFRESH_MS);
        account.faults = { refuse: () => "no-answer" };
        expect(await refreshBoatKeyReports(options)).toContainEqual({
          account: id,
          outcome: "kept",
        });
        expect((await reports()).get(id)).toEqual(suspended.get(id));
        account.faults = {};

        // And a key Boat now refuses outright is reported as refused, with Boat's reason.
        account.faults = {
          refuse: () => BOAT_REFUSALS["key-expired"],
        };
        expect(await refreshBoatKeyReports(options)).toContainEqual({
          account: id,
          outcome: "refreshed",
        });
        const expired = (await reports()).get(id)?.report;
        expect(expired).toMatchObject({
          identity: { observed: false, reason: "refused", boat: { kind: "key-expired" } },
        });
        // No key in any report.
        expect(JSON.stringify([...(await reports()).values()])).not.toContain(ACCOUNT_KEY);
        expect(JSON.stringify([...(await reports()).values()])).not.toContain(INSTALL_KEY);
      } finally {
        await Promise.all([account.stop(), install.stop()]);
      }
    }));
});
