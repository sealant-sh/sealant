/**
 * The SDK's `scopes` against the API booted in this process: the real contract, transport gate,
 * handlers and repository on Postgres, listening on loopback. Gated on SEALANT_TEST_DATABASE_URL
 * (a disposable, migrated database).
 */
import { randomUUID } from "node:crypto";

import { createSealantDB, ResourceDomainRepoLive, SealantDB, user, type DB } from "@sealant/db";
import { Sealant, SealantApiError } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gateControlPlane, listenOnLoopback } from "../control-plane.fixture.js";
import { ResourceDomainsHandlersLive } from "./resource-domains.http-api.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
const SERVICE_KEY = `slt_scopes_${randomUUID()}`;

describe.skipIf(DATABASE_URL === undefined)("sealant.scopes against the API", () => {
  let db: DB;
  let api: Awaited<ReturnType<typeof listenOnLoopback>>;
  let sealant: Sealant;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    api = await listenOnLoopback(
      gateControlPlane({
        handlers: ResourceDomainsHandlersLive,
        provides: ResourceDomainRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db))),
        groups: ["resourceDomains"],
        serviceKey: SERVICE_KEY,
      }),
    );
    sealant = new Sealant({ baseUrl: api.baseUrl, apiKey: SERVICE_KEY });
  });

  afterAll(async () => {
    await sealant.close();
    await api.close();
  });

  const person = async () => {
    const id = `user_scopes_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(user).values({ id, name: "scopes", email: `${id}@example.test` }),
    );
    return id;
  };

  it("ensures a scope once and reads it back", async () => {
    const key = `mend:install-1:project:${randomUUID()}`;
    const first = await sealant.scopes.ensure({ key });
    expect(first).toMatchObject({ key, created: true });
    expect(first.id).toMatch(/^rdm:/);
    expect(await sealant.scopes.ensure({ key })).toEqual({ ...first, created: false });
    const { created: _created, ...scope } = first;
    expect(await sealant.scopes.get(first.id)).toEqual(scope);
    expect(await sealant.scopes.actAs(first.id).get()).toEqual(scope);
  });

  it("grants, revokes and lists members, and a delayed grant cannot undo the revoke", async () => {
    const { id } = await sealant.scopes.ensure({ key: `mend:install-1:project:${randomUUID()}` });
    const project = sealant.scopes.actAs(id);
    const [alice, bob] = [await person(), await person()];

    const granted = await project.members.grant(alice, { expectedVersion: 0 });
    expect(granted).toMatchObject({ userId: alice, state: "member", version: 1 });
    expect(await project.members.grant(alice, { expectedVersion: 0 })).toEqual(granted);
    await project.members.grant(bob, { expectedVersion: 0 });
    const revoked = await project.members.revoke(bob, { expectedVersion: 1 });
    expect(revoked).toMatchObject({ userId: bob, state: "revoked", version: 2 });

    const late = project.members.grant(bob, { expectedVersion: 0 });
    await expect(late).rejects.toBeInstanceOf(SealantApiError);
    await expect(late).rejects.toMatchObject({ code: "ResourceDomainMemberVersionConflictError" });

    expect(await project.members.list()).toEqual(
      [granted, revoked].toSorted((a, b) => a.userId.localeCompare(b.userId)),
    );
  });

  it("is refused with the transport's 401 to a client without the service key", async () => {
    const stranger = new Sealant({ baseUrl: api.baseUrl, apiKey: "slt_not_a_service_key" });
    const refused = stranger.scopes.ensure({ key: `mend:install-1:project:${randomUUID()}` });
    await expect(refused).rejects.toBeInstanceOf(SealantApiError);
    await expect(refused).rejects.toMatchObject({ status: 401 });
    await stranger.close();
  });
});
