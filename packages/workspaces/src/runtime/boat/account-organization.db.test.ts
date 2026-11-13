/**
 * A stored account that names a Boat organization: the worker's client for it (the account
 * directory's) names the organization on every request, a VM create included, so billing never
 * follows the key's active wallet (SLNT-781). Against the fake Boat.
 */
import { randomUUID } from "node:crypto";

import type { CredentialCipherService } from "@sealant/credentials";
import { BoatAccountRepo, BoatAccountRepoLive, SealantDB, createSealantDB } from "@sealant/db";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { FakeBoat } from "../../../boat-harness/fake-boat.js";
import { BoatAccountDirectory } from "./accounts.js";
import { HttpBoatApi } from "./api.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
const KEY = "boat_live_fixture_pinned_key_0003";
const cipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

describe.skipIf(databaseUrl === undefined)("a stored account's organization", () => {
  it("is named on the worker's create for the account", () =>
    withWorkspaceJobTestDatabase(databaseUrl ?? "", async (url) => {
      const boat = new FakeBoat({
        runId: "orgpin01",
        credential: KEY,
        network: "unit",
        baseImage: "unit-base",
        docker: async (args) => ({
          code: 0,
          stdout: args[0] === "inspect" ? "192.0.10.5\n" : "running\n",
          stderr: "",
          timedOut: false,
        }),
      });
      await boat.start();
      const db = await createSealantDB(url);
      try {
        const id = randomUUID();
        await Effect.runPromise(
          Effect.flatMap(BoatAccountRepo, (repo) =>
            repo.create({
              id,
              label: "Pinned",
              sealedKey: `sealed:${KEY}`,
              keyId: "k-test",
              organization: "team_acme",
            }),
          ).pipe(
            Effect.provide(BoatAccountRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db)))),
          ),
        );
        const directory = new BoatAccountDirectory({
          db,
          cipher,
          clientFor: (credential, options) =>
            HttpBoatApi.create({
              credential,
              baseUrl: boat.baseUrl,
              ...(options?.organization === undefined
                ? {}
                : { organization: options.organization }),
            }),
        });
        const provider = await directory.provider(id);
        if (provider === undefined) throw new Error("no provider");
        const created = await provider.api.create({
          idempotencyKey: randomUUID(),
          marker: randomUUID(),
          purpose: "native-build",
          lifetime: { kind: "bounded" },
          requestVersion: 2,
        });
        expect(created.ok).toBe(true);
        expect(boat.organizationHeaders).toEqual([
          { method: "POST", path: "/sandboxes", organization: "team_acme" },
        ]);
      } finally {
        await boat.stop();
      }
    }));
});
