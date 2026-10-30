/**
 * Resource domains against real Postgres: concurrent ensures of one key answer one domain, and
 * the database itself keeps a domain id out of every column that names a person, including the
 * credential home's holder, which no foreign key holds to `user`. Gated on
 * SEALANT_TEST_DATABASE_URL (a disposable, migrated database).
 */
import { randomUUID } from "node:crypto";

import { RESOURCE_DOMAIN_ID_PREFIX } from "@sealant/api-contracts";
import {
  createSealantDB,
  ResourceDomainRepo,
  ResourceDomainRepoLive,
  schema,
  SealantDB,
  user,
  workspaceAttempts,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Cause, Effect, Exit, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

/** The constraint a write broke, as Postgres names it, or `undefined` when it was written. */
const refusedBy = async <A, E>(write: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(write);
  if (Exit.isSuccess(exit)) return undefined;
  return (
    /violates [a-z ]+ constraint "([^"]+)"/.exec(Cause.pretty(exit.cause))?.[1] ??
    "not a constraint"
  );
};

const domainId = () => `${RESOURCE_DOMAIN_ID_PREFIX}${randomUUID()}`;

describe.skipIf(DATABASE_URL === undefined)("resource domains (Postgres)", () => {
  let db: DB;
  const person = `user_domains_${randomUUID()}`;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    await Effect.runPromise(
      db.insert(user).values({ id: person, name: "domains", email: `${person}@example.test` }),
    );
  });

  const provided = <A, E>(
    effect: Effect.Effect<A, E, ResourceDomainRepo | WorkspaceRuntimeInstanceRepo>,
  ) =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(ResourceDomainRepoLive, WorkspaceRuntimeInstanceRepoLive).pipe(
          Layer.provide(Layer.succeed(SealantDB, db)),
        ),
      ),
    );

  it("answers one domain to concurrent ensures of one key, created once", async () => {
    const key = `test:${randomUUID()}`;
    const results = await Effect.runPromise(
      provided(
        Effect.flatMap(ResourceDomainRepo, (repo) =>
          Effect.all(
            Array.from({ length: 16 }, () => repo.ensure(key)),
            { concurrency: "unbounded" },
          ),
        ),
      ),
    );
    expect(new Set(results.map(({ domain }) => domain.id)).size).toBe(1);
    expect(results.filter((result) => result.kind === "ensured" && result.created)).toHaveLength(1);
    const [first] = results;
    expect(first?.domain.id.startsWith(RESOURCE_DOMAIN_ID_PREFIX)).toBe(true);
    expect(
      await Effect.runPromise(
        provided(Effect.flatMap(ResourceDomainRepo, (repo) => repo.get(first?.domain.id ?? ""))),
      ),
    ).toEqual(first?.domain);
  });

  it("refuses a person whose id is a domain's", async () => {
    const id = domainId();
    expect(
      await refusedBy(db.insert(user).values({ id, name: "domain", email: `${id}@example.test` })),
    ).toBe("user_id_not_resource_domain");
  });

  it("never takes a domain as a member: no person may have its id, so the member's key to a person refuses it", async () => {
    const key = `test:${randomUUID()}`;
    const { domain } = await Effect.runPromise(
      provided(Effect.flatMap(ResourceDomainRepo, (repo) => repo.ensure(key))),
    );
    expect(
      await refusedBy(
        db
          .insert(user)
          .values({ id: domain.id, name: "domain", email: `${domain.id}@example.test` }),
      ),
    ).toBe("user_id_not_resource_domain");
    expect(
      await refusedBy(
        db.insert(schema.resourceDomainMembers).values({
          resourceDomainId: domain.id,
          userId: domain.id,
          state: "member",
          version: 1,
        }),
      ),
    ).toBe("resource_domain_members_user_id_user_id_fkey");
    expect(
      await refusedBy(
        db.insert(schema.resourceDomains).values({ id: person, key: `test:${randomUUID()}` }),
      ),
    ).toBe("resource_domains_id_is_rdm_uuid");
  });

  it("lets a person who was a member be deleted, with their member row, and keeps the domain", async () => {
    const member = `user_member_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(user).values({ id: member, name: "member", email: `${member}@example.test` }),
    );
    const { domain } = await Effect.runPromise(
      provided(Effect.flatMap(ResourceDomainRepo, (repo) => repo.ensure(`test:${randomUUID()}`))),
    );
    await Effect.runPromise(
      db.insert(schema.resourceDomainMembers).values({
        resourceDomainId: domain.id,
        userId: member,
        state: "revoked",
        version: 2,
      }),
    );
    expect(
      await refusedBy(db.execute(`DELETE FROM "user" WHERE "id" = '${member}'`)),
    ).toBeUndefined();
    const rows = await Effect.runPromise(db.select().from(schema.resourceDomainMembers));
    const left = rows.filter((row) => row.userId === member);
    expect(left).toEqual([]);
    expect(
      await Effect.runPromise(
        provided(Effect.flatMap(ResourceDomainRepo, (repo) => repo.get(domain.id))),
      ),
    ).toEqual(domain);
  });

  it("refuses a domain as the person whose logins a credential home holds", async () => {
    const runId = `run_domains_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(workspaceAttempts).values({ id: runId, ownerUserId: person }),
    );
    await Effect.runPromise(
      provided(
        Effect.flatMap(WorkspaceRuntimeInstanceRepo, (instances) =>
          instances.upsertRuntimeInstance({
            runId,
            status: "ready",
            adapter: "docker",
            resourceId: `container-${runId}`,
            launchCredentialInjections: [],
          }),
        ),
      ),
    );
    const home = (onBehalfOfUserId: string, path: string) =>
      db.insert(schema.workspaceCredentialHomes).values({
        runId,
        home: path,
        onBehalfOfUserId,
        generation: "generation-1",
      });
    expect(await refusedBy(home(domainId(), "/home/domain"))).toBe(
      "workspace_credential_homes_holder_not_resource_domain",
    );
    expect(await refusedBy(home(person, "/home/person"))).toBeUndefined();
  });
});
