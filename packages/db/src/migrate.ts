/**
 * Programmatic migration runner for prebuilt images: applies the committed SQL migrations without
 * drizzle-kit or the monorepo source. It records into the same journal as drizzle-kit
 * (drizzle.__drizzle_migrations, matched by content hash + name), so dev `db:migrate` runs and
 * packaged installs share one migration history.
 *
 * Some migrations need maintenance that cannot run inside the migration transaction (VACUUM).
 * After the migrations commit, the runner runs it for each migration this run newly applied
 * (`POST_MIGRATION_MAINTENANCE`), and logs what each step did: done, skipped (with Postgres's
 * reason, for a role that may not vacuum a table), or failed. A step that does not get done never
 * fails the migration, which has already committed.
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
 * arguments. VACUUM marks the old row versions' space free for reuse, so new rows overwrite them;
 * autovacuum would not get to them soon, because the rewrite touches a small share of each table.
 * It does not zero that space or shrink the files (only `VACUUM FULL` rewrites them, under an
 * exclusive lock). The WAL holding the rewrite is recycled after the next automatic checkpoint:
 * an explicit CHECKPOINT needs a superuser or `pg_checkpoint`, which an app's owner role is not.
 */
export const POST_MIGRATION_MAINTENANCE: Readonly<Record<string, readonly MaintenanceStep[]>> = {
  "20261006054100_stored_arguments_withheld": [
    { sql: 'VACUUM "telemetry_events"' },
    { sql: 'VACUUM "telemetry_timeline"' },
    { sql: 'VACUUM "runs"' },
    { sql: 'VACUUM "workspace_sessions"' },
    { sql: 'VACUUM "pgboss"."job"', whenRelationExists: "pgboss.job" },
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
    // A VACUUM the role may not run on a table succeeds with a WARNING ("skipping …") instead of
    // an error: collect what Postgres says, so the log reports a skip as a skip.
    const warnings: string[] = [];
    const onNotice = (notice: {
      readonly severity: string | undefined;
      readonly message: string | undefined;
    }) => {
      if (notice.severity === "WARNING" && notice.message !== undefined) {
        warnings.push(notice.message);
      }
    };
    client.on("notice", onNotice);
    const startedAt = Date.now();
    try {
      await client.query(step.sql);
      const elapsed = Date.now() - startedAt;
      log(
        warnings.length === 0
          ? `[migrate] after ${migration}: ${step.sql} done (${elapsed} ms)`
          : `[migrate] after ${migration}: ${step.sql} skipped: ${warnings.join("; ")}. Run it as the table's owner.`,
      );
    } catch (error) {
      log(
        `[migrate] after ${migration}: ${step.sql} failed (${error instanceof Error ? error.message : String(error)}). Run it as the table's owner.`,
      );
    } finally {
      client.off("notice", onNotice);
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
