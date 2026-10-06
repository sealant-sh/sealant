/**
 * Programmatic migration runner for prebuilt images: applies the committed SQL migrations without
 * drizzle-kit or the monorepo source. It records into the same journal as drizzle-kit
 * (drizzle.__drizzle_migrations, matched by content hash + name), so dev `db:migrate` runs and
 * packaged installs share one migration history.
 *
 * Some migrations need maintenance that cannot run inside the migration transaction (VACUUM,
 * CHECKPOINT). After the migrations commit, the runner runs it for each migration this run newly
 * applied (`POST_MIGRATION_MAINTENANCE`). A step that fails is logged with the command to run by
 * hand; it does not fail the migration, which has already committed.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

export interface RunMigrationsOptions {
  readonly databaseUrl: string;
  readonly migrationsFolder: string;
  /** Where maintenance progress goes; defaults to console.log / console.error. */
  readonly log?: (line: string) => void;
}

export interface RunMigrationsResult {
  /** Migrations this run applied, by folder name, oldest first. */
  readonly applied: readonly string[];
}

interface MaintenanceStep {
  readonly sql: string;
  /** Run only when this relation exists (pg-boss creates its schema at runtime). */
  readonly whenRelationExists?: string;
}

/**
 * `stored_arguments_withheld` rewrote every stored row that held a process's or session's
 * arguments. The old row versions stay in the table files until VACUUM and in the WAL until a
 * CHECKPOINT lets it be recycled: autovacuum would not get to them soon, because the rewrite
 * touches a small share of each table.
 */
export const POST_MIGRATION_MAINTENANCE: Readonly<Record<string, readonly MaintenanceStep[]>> = {
  "20261006054100_stored_arguments_withheld": [
    { sql: 'VACUUM "telemetry_events"' },
    { sql: 'VACUUM "telemetry_timeline"' },
    { sql: 'VACUUM "runs"' },
    { sql: 'VACUUM "workspace_sessions"' },
    { sql: 'VACUUM "pgboss"."job"', whenRelationExists: "pgboss.job" },
    { sql: "CHECKPOINT" },
  ],
};

const appliedMigrationNames = async (client: Client): Promise<ReadonlySet<string>> => {
  const journal = await client.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
  );
  if (journal.rows[0]?.present !== true) {
    return new Set();
  }
  const rows = await client.query<{ name: string | null }>(
    "SELECT name FROM drizzle.__drizzle_migrations ORDER BY id",
  );
  return new Set(rows.rows.flatMap((row) => (row.name === null ? [] : [row.name])));
};

const runMaintenance = async (
  client: Client,
  migration: string,
  steps: readonly MaintenanceStep[],
  log: (line: string) => void,
): Promise<void> => {
  for (const step of steps) {
    if (step.whenRelationExists !== undefined) {
      const exists = await client.query<{ present: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [step.whenRelationExists],
      );
      if (exists.rows[0]?.present !== true) {
        continue;
      }
    }
    const startedAt = Date.now();
    try {
      await client.query(step.sql);
      log(`[migrate] after ${migration}: ${step.sql} (${Date.now() - startedAt} ms)`);
    } catch (error) {
      log(
        `[migrate] after ${migration}: ${step.sql} failed (${error instanceof Error ? error.message : String(error)}). Run it as the database owner or a superuser: psql "$DATABASE_URL" -c '${step.sql}'`,
      );
    }
  }
};

export const runMigrations = async (
  options: RunMigrationsOptions,
): Promise<RunMigrationsResult> => {
  const log = options.log ?? ((line: string) => console.log(line));
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const before = await appliedMigrationNames(client);
    const db = drizzle(options.databaseUrl);
    try {
      const result = await migrate(db, { migrationsFolder: options.migrationsFolder });
      // migrate() only returns a value for init-mode failures; normal runs resolve void.
      if (result !== undefined) {
        throw new Error(`migration init failed: ${result.exitCode}`);
      }
    } finally {
      await db.$client.end();
    }
    const applied = [...(await appliedMigrationNames(client))].filter((name) => !before.has(name));
    for (const migration of applied) {
      const steps = POST_MIGRATION_MAINTENANCE[migration];
      if (steps !== undefined) {
        await runMaintenance(client, migration, steps, log);
      }
    }
    return { applied };
  } finally {
    await client.end();
  }
};
