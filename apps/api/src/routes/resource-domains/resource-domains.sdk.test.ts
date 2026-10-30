/**
 * The SDK's `scopes` against the API booted in this process: the real contract, transport gate,
 * handlers and repository on Postgres, listening on loopback. Gated on SEALANT_TEST_DATABASE_URL
 * (a disposable, migrated database).
 */
import { randomUUID } from "node:crypto";

import {
  createSealantDB,
  ResourceDomainRepoLive,
  schema,
  SealantDB,
  user,
  type DB,
} from "@sealant/db";
import { Sealant, SealantApiError } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { controlPlaneRoutes, gateControlPlane } from "../control-plane.fixture.js";
import { ResourceDomainsHandlersLive } from "./resource-domains.http-api.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
const SERVICE_KEY = `slt_scopes_${randomUUID()}`;

describe.skipIf(DATABASE_URL === undefined)("sealant.scopes against the API", () => {
  let db: DB;
  let api: Awaited<ReturnType<typeof gateControlPlane>>;
  let sealant: Sealant;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    api = await gateControlPlane(
      controlPlaneRoutes({
        handlers: ResourceDomainsHandlersLive,
        provides: ResourceDomainRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db))),
        groups: ["resourceDomains"],
      }),
      SERVICE_KEY,
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

    const granted = await project.members.grant(alice, { version: 1 });
    expect(granted).toMatchObject({ userId: alice, state: "member", version: 1 });
    expect(await project.members.grant(alice, { version: 1 })).toEqual(granted);
    await project.members.grant(bob, { version: 1 });
    const revoked = await project.members.revoke(bob, { version: 2 });
    expect(revoked).toMatchObject({ userId: bob, state: "revoked", version: 2 });

    const late = project.members.grant(bob, { version: 1 });
    await expect(late).rejects.toBeInstanceOf(SealantApiError);
    await expect(late).rejects.toMatchObject({ code: "ResourceDomainMemberVersionConflictError" });

    const nobody = project.members.grant(`user_nobody_${randomUUID()}`, { version: 1 });
    await expect(nobody).rejects.toMatchObject({ code: "ResourceDomainPersonNotFoundError" });
    const elsewhere = sealant.scopes
      .actAs("rdm:00000000-0000-4000-8000-0000000000ff")
      .members.grant(alice, { version: 1 });
    await expect(elsewhere).rejects.toMatchObject({ code: "ResourceDomainNotFoundError" });

    expect(await project.members.get(bob)).toEqual(revoked);
    const [first, second] = [granted, revoked].toSorted((a, b) => a.userId.localeCompare(b.userId));
    const page = await project.members.list({ limit: 1 });
    expect(page).toEqual({ items: [first], nextCursor: first?.userId });
    expect(await project.members.list({ limit: 1, cursor: page.nextCursor ?? "" })).toEqual({
      items: [second],
    });
  });

  /** An allocation written as admission writes one, which a later change brings. */
  const hold = async (
    resourceDomainId: string,
    row: Partial<typeof schema.resourceDomainAllocations.$inferInsert>,
  ) => {
    const [written] = await Effect.runPromise(
      db
        .insert(schema.resourceDomainAllocations)
        .values({
          id: randomUUID(),
          resourceDomainId,
          use: "volume",
          objectKey: `volume:${randomUUID()}`,
          operationKey: randomUUID(),
          ...row,
        })
        .returning(),
    );
    return written?.id ?? "";
  };

  it("starts a scope with a budget, and ensuring it never changes the budget", async () => {
    const key = `mend:install-1:project:${randomUUID()}`;
    const limits = { cpuMillicores: 4000, memoryBytes: 4096, storageBytes: 1000 };
    const { id } = await sealant.scopes.ensure({ key, budget: limits });
    expect(await sealant.scopes.ensure({ key, budget: limits })).toMatchObject({ created: false });
    expect(await sealant.scopes.ensure({ key })).toMatchObject({ created: false });
    await sealant.scopes.actAs(id).budget.set({ ...limits, revision: 1 });
    const differs = sealant.scopes.ensure({ key, budget: { ...limits, storageBytes: 1 } });
    await expect(differs).rejects.toMatchObject({
      code: "ResourceDomainBudgetDiffersError",
      cause: { resourceDomainId: id, revision: 2 },
    });
    const unbudgeted = await sealant.scopes.ensure({
      key: `mend:install-1:project:${randomUUID()}`,
    });
    expect(await sealant.scopes.actAs(unbudgeted.id).budget.get()).toMatchObject({
      revision: 1,
      cpuMillicores: { limit: 0, used: 0, reserved: 0, warning: "full" },
    });
    expect(await sealant.scopes.actAs(id).budget.get()).toEqual({
      revision: 2,
      cpuMillicores: { limit: 4000, used: 0, reserved: 0, warning: "none" },
      memoryBytes: { limit: 4096, used: 0, reserved: 0, warning: "none" },
      storageBytes: {
        limit: 1000,
        used: 0,
        reserved: 0,
        warning: "none",
        archived: 0,
        protection: 0,
      },
    });
  });

  it("sets a budget at the revision read, and refuses one set against a stale revision", async () => {
    const { id } = await sealant.scopes.ensure({ key: `mend:install-1:project:${randomUUID()}` });
    const project = sealant.scopes.actAs(id);
    const { revision } = await project.budget.get();
    const limits = { cpuMillicores: 2000, memoryBytes: 2048, storageBytes: 500 };
    const set = await project.budget.set({ ...limits, revision });
    expect(set).toMatchObject({ revision: revision + 1, storageBytes: { limit: 500 } });
    const stale = project.budget.set({ ...limits, storageBytes: 9000, revision });
    await expect(stale).rejects.toMatchObject({
      code: "ResourceDomainBudgetRevisionConflictError",
      cause: { revision: revision + 1 },
    });
    expect(await project.budget.get()).toEqual(set);
  });

  it("warns at 80% and 95% of a limit and when it is full, counting archived and protection space", async () => {
    const { id } = await sealant.scopes.ensure({
      key: `mend:install-1:project:${randomUUID()}`,
      budget: { cpuMillicores: 1000, memoryBytes: 1000, storageBytes: 1000 },
    });
    const project = sealant.scopes.actAs(id);
    const warning = async () => (await project.budget.get()).storageBytes.warning;

    await hold(id, { storageBytes: 799 });
    expect(await warning()).toBe("none");
    await hold(id, { storageBytes: 1 });
    expect(await warning()).toBe("80-percent");
    await hold(id, { storageBytes: 149 });
    expect(await warning()).toBe("80-percent");
    await hold(id, { storageBytes: 1 });
    expect(await warning()).toBe("95-percent");
    await hold(id, { storageBytes: 50 });
    expect(await warning()).toBe("full");
  });

  it("charges a volume's unused reserve and every backup, and reports only backups as protection", async () => {
    const { id } = await sealant.scopes.ensure({
      key: `mend:install-1:project:${randomUUID()}`,
      budget: { cpuMillicores: 1000, memoryBytes: 1000, storageBytes: 2000 },
    });
    const project = sealant.scopes.actAs(id);
    const data = await hold(id, { storageBytes: 700, protectionBytes: 300, state: "archived" });
    expect((await project.budget.get()).storageBytes).toMatchObject({
      used: 1000,
      archived: 700,
      protection: 0,
    });
    const backup = (protectionBytes: number) =>
      hold(id, { use: "protection", sourceAllocationId: data, protectionBytes });
    await backup(200);
    expect((await project.budget.get()).storageBytes).toMatchObject({
      used: 800,
      reserved: 200,
      protection: 200,
    });
    await backup(250);
    expect((await project.budget.get()).storageBytes).toEqual({
      limit: 2000,
      used: 700,
      reserved: 450,
      warning: "none",
      archived: 700,
      protection: 450,
    });
  });

  it("is refused with the transport's 401 to a client without the service key", async () => {
    const stranger = new Sealant({ baseUrl: api.baseUrl, apiKey: "slt_not_a_service_key" });
    const refused = stranger.scopes.ensure({ key: `mend:install-1:project:${randomUUID()}` });
    await expect(refused).rejects.toBeInstanceOf(SealantApiError);
    await expect(refused).rejects.toMatchObject({ status: 401 });
    await stranger.close();
  });
});
