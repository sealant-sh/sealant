/**
 * Programmatic migration runner for prebuilt images: applies the committed SQL migrations without
 * drizzle-kit or the monorepo source. It records into the same journal as drizzle-kit
 * (drizzle.__drizzle_migrations, matched by content hash + name), so dev `db:migrate` runs and
 * packaged installs share one migration history.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export interface RunMigrationsOptions {
  readonly databaseUrl: string;
  readonly migrationsFolder: string;
}

export const runMigrations = async (options: RunMigrationsOptions): Promise<void> => {
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
};
