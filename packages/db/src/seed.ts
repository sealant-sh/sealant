/**
 * Idempotent seed for a fresh self-host database: ensure the default owner principal exists.
 *
 * The SDK attributes sandboxes/runs to `ownerUserId` (default "usr_local") before auth lands; a fresh
 * control-plane DB has no users, so `create` would fail the owner FK. Run after migrations
 * (`pnpm --filter @sealant/db db:seed`). Safe to re-run.
 */
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL ?? process.env.SEALANT_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error("[seed] DATABASE_URL (or SEALANT_DATABASE_URL) is required.");
  process.exit(1);
}

const ownerId = process.env.SEALANT_OWNER_USER_ID ?? "usr_local";
const ownerEmail = process.env.SEALANT_OWNER_EMAIL ?? "local@example.test";
const ownerName = process.env.SEALANT_OWNER_NAME ?? "Local";

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  // created_at/updated_at have drizzle-level defaults ($defaultFn), not DB defaults, so a raw insert
  // must set them explicitly.
  await client.query(
    'INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $2, $3, true, now(), now()) ON CONFLICT DO NOTHING',
    [ownerId, ownerName, ownerEmail],
  );
  console.log(`[seed] default owner '${ownerId}' ensured.`);
} finally {
  await client.end();
}
