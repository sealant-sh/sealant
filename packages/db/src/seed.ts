/**
 * Idempotent seed for a fresh self-host database: ensure the default owner principal exists.
 *
 * The SDK attributes sandboxes/runs to `ownerUserId` (default "usr_local") before auth lands; a fresh
 * control-plane DB has no users, so `create` would fail the owner FK. Run after migrations
 * (`pnpm --filter @sealant/db db:seed`). Safe to re-run.
 *
 * When the dev gateway client key exists (written by `pnpm ssh:setup:dev`), it is also registered
 * in `ssh_keys` under the default owner so the SSH gateway can resolve it to a principal that
 * actually owns SDK/self-host sandboxes — no hand-editing of allowlist comments required.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSshPublicKey } from "@sealant/validators/ssh-public-key";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL ?? process.env.SEALANT_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error("[seed] DATABASE_URL (or SEALANT_DATABASE_URL) is required.");
  process.exit(1);
}

const ownerId = process.env.SEALANT_OWNER_USER_ID ?? "usr_local";
const ownerEmail = process.env.SEALANT_OWNER_EMAIL ?? "local@example.test";
const ownerName = process.env.SEALANT_OWNER_NAME ?? "Local";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)), "..");
const devSshPublicKeyPath =
  process.env.SEALANT_DEV_SSH_PUBLIC_KEY_FILE ?? resolve(repoRoot, ".secrets", "dev_client_key.pub");

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

  if (existsSync(devSshPublicKeyPath)) {
    const parsed = parseSshPublicKey(readFileSync(devSshPublicKeyPath, "utf8"));

    await client.query(
      `INSERT INTO ssh_keys (id, owner_user_id, name, public_key, fingerprint, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (owner_user_id, fingerprint) DO NOTHING`,
      [
        `sshk_${randomUUID()}`,
        ownerId,
        parsed.comment ?? "sealant-ssh-gateway-dev-client",
        parsed.normalized,
        parsed.fingerprint,
      ],
    );
    console.log(`[seed] dev SSH key ${parsed.fingerprint} registered to '${ownerId}'.`);
  } else {
    console.log(`[seed] no dev SSH key at ${devSshPublicKeyPath}; skipping key registration.`);
  }
} finally {
  await client.end();
}
