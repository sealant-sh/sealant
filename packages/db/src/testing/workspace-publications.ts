import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * An isolated database migrated up to, and not including, `migration`: what a deployment held
 * right before it. `run` writes rows of that earlier schema through `client`, then calls
 * `upgrade`, which applies every remaining migration and rejects with a migration's own error when
 * one refuses.
 */
export const withDatabaseBeforeMigration = async <A>(
  databaseUrl: string,
  migration: string,
  run: (context: {
    readonly url: string;
    readonly client: Client;
    readonly upgrade: () => Promise<void>;
  }) => Promise<A>,
): Promise<A> => {
  const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
  const earlier = (await readdir(migrationsFolder)).filter((name) => name < migration);
  if (earlier.length === 0 || !(await readdir(migrationsFolder)).includes(migration))
    throw new Error(`unknown migration ${migration}`);
  const name = `boat_upgrade_${randomUUID().replaceAll("-", "")}`;
  const before = await mkdtemp(join(tmpdir(), "sealant-migrations-"));
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  let created = false;
  try {
    // The earlier migrations, by link: the runner reads a folder, and applies all of it.
    await Promise.all(
      earlier.map((folder) => symlink(join(migrationsFolder, folder), join(before, folder))),
    );
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const isolated = new URL(databaseUrl);
    isolated.pathname = `/${name}`;
    await runMigrations({
      databaseUrl: isolated.href,
      migrationsFolder: before,
      log: () => undefined,
    });
    const client = new Client({ connectionString: isolated.href });
    await client.connect();
    try {
      return await run({
        url: isolated.href,
        client,
        upgrade: async () => {
          await runMigrations({
            databaseUrl: isolated.href,
            migrationsFolder,
            log: () => undefined,
          });
        },
      });
    } finally {
      await client.end();
    }
  } finally {
    try {
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
      await rm(before, { recursive: true, force: true });
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
