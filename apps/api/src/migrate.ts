/**
 * One-shot entrypoint for the packaged self-host `migrate` service: apply the committed SQL
 * migrations, then seed the default owner principal (a fresh DB has no users, and the SDK
 * attributes work to `usr_local`). Bundled to dist/migrate.js next to the API server bundle so the
 * prebuilt api image can run it directly — no pnpm, no drizzle-kit, no source tree.
 */
import { runMigrations } from "@sealant/db/migrate";
import { runSeed } from "@sealant/db/seed-core";

const databaseUrl = process.env.DATABASE_URL ?? process.env.SEALANT_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error("[migrate] DATABASE_URL (or SEALANT_DATABASE_URL) is required.");
  process.exit(1);
}

// The api image copies packages/db/drizzle to /app/drizzle (see apps/api/Dockerfile).
const migrationsFolder = process.env.DRIZZLE_MIGRATIONS_DIR ?? "/app/drizzle";

try {
  console.log(`[migrate] applying migrations from ${migrationsFolder}…`);
  await runMigrations({ databaseUrl, migrationsFolder });
  console.log("[migrate] migrations applied.");

  await runSeed({
    databaseUrl,
    devSshPublicKeyPath: process.env.SEALANT_DEV_SSH_PUBLIC_KEY_FILE,
  });

  process.exit(0);
} catch (error) {
  console.error("[migrate] failed:", error);
  process.exit(1);
}
