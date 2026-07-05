/**
 * Idempotent seed for a fresh self-host database: ensure the default owner principal exists.
 *
 * The SDK attributes sandboxes/runs to `ownerUserId` (default "usr_local") before auth lands; a fresh
 * control-plane DB has no users, so `create` would fail the owner FK. Run after migrations. Safe to
 * re-run.
 *
 * When a dev gateway client key is provided and exists on disk (written by `pnpm ssh:setup:dev`), it
 * is also registered in `ssh_keys` under the default owner so the SSH gateway can resolve it to a
 * principal that actually owns SDK/self-host sandboxes.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { parseSshPublicKey } from "@sealant/validators/ssh-public-key";
import { Client } from "pg";

export interface RunSeedOptions {
  readonly databaseUrl: string;
  readonly ownerId?: string | undefined;
  readonly ownerEmail?: string | undefined;
  readonly ownerName?: string | undefined;
  /** Dev gateway client public key to register under the owner; skipped when unset or missing. */
  readonly devSshPublicKeyPath?: string | undefined;
}

export const runSeed = async (options: RunSeedOptions): Promise<void> => {
  const ownerId = options.ownerId ?? "usr_local";
  const ownerEmail = options.ownerEmail ?? "local@example.test";
  const ownerName = options.ownerName ?? "Local";

  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    // created_at/updated_at have drizzle-level defaults ($defaultFn), not DB defaults, so a raw insert
    // must set them explicitly.
    await client.query(
      'INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, $2, $3, true, now(), now()) ON CONFLICT DO NOTHING',
      [ownerId, ownerName, ownerEmail],
    );
    console.log(`[seed] default owner '${ownerId}' ensured.`);

    if (options.devSshPublicKeyPath !== undefined && existsSync(options.devSshPublicKeyPath)) {
      const parsed = parseSshPublicKey(readFileSync(options.devSshPublicKeyPath, "utf8"));

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
      console.log("[seed] no dev SSH key provided; skipping key registration.");
    }
  } finally {
    await client.end();
  }
};
