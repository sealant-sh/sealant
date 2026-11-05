import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Client } from "pg";

import type { DB } from "../client.js";
import { runMigrations } from "../migrate.js";
import { workspaceBuildJobs } from "../schema.js";
import { resourceDomains, resourceDomainMembers } from "../schema/resource-domains.js";

/** An isolated migrated database for tests that sweep the entire durable job queue. */
export const withWorkspaceJobTestDatabase = async <A>(
  databaseUrl: string,
  run: (url: string) => Promise<A>,
): Promise<A> => {
  const name = `boat_queue_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const isolated = new URL(databaseUrl);
    isolated.pathname = `/${name}`;
    await runMigrations({
      databaseUrl: isolated.href,
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
      log: () => undefined,
    });
    return await run(isolated.href);
  } finally {
    try {
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
};

/** Seed fake authorization facts only in a disposable test database. */
export const seedImageScope = (db: DB, domainId: string, owner: string) =>
  db.transaction(() =>
    Effect.gen(function* () {
      yield* db.insert(resourceDomains).values({ id: domainId, key: `stage2b:${domainId}` });
      yield* db
        .insert(resourceDomainMembers)
        .values({ resourceDomainId: domainId, userId: owner, state: "member", version: 1 });
    }),
  );

/** A newer application decision revokes image reuse without changing existing pins. */
export const revokeImageScope = (db: DB, domainId: string) =>
  db
    .update(resourceDomainMembers)
    .set({ state: "revoked", version: 2 })
    .where(eq(resourceDomainMembers.resourceDomainId, domainId));

/** Take the job claim at a deterministic build boundary. */
export const takeWorkspaceJobClaim = (db: DB, id: string) =>
  db
    .update(workspaceBuildJobs)
    .set({ workerId: "successor", attemptCount: 2 })
    .where(eq(workspaceBuildJobs.id, id));

/** Inject serialized rows to exercise the real repository parser. */
export const corruptWorkspacePublication = (
  db: DB,
  table: "job" | "runtime",
  id: string,
  value: unknown,
) =>
  table === "job"
    ? db.execute(
        sql`update oci_image_build_jobs set publication = ${JSON.stringify(value)}::jsonb where id = ${id}`,
      )
    : db.execute(
        sql`update workspace_runtime_instances set publication = ${JSON.stringify(value)}::jsonb where run_id = ${id}`,
      );

/** Exercise each refusal using the persisted authorization state. */
export const setImageScopeState = (
  db: DB,
  domainId: string,
  state: "active" | "fenced" | "archived",
) => db.update(resourceDomains).set({ state }).where(eq(resourceDomains.id, domainId));
