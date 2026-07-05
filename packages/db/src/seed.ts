/**
 * CLI wrapper for the seed (`pnpm --filter @sealant/db db:seed`). The packaged self-host path calls
 * runSeed() from the bundled api migrate entrypoint instead — keep all seeding logic in seed-core.ts.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runSeed } from "./seed-core.js";

const databaseUrl = process.env.DATABASE_URL ?? process.env.SEALANT_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error("[seed] DATABASE_URL (or SEALANT_DATABASE_URL) is required.");
  process.exit(1);
}

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)), "..");

await runSeed({
  databaseUrl,
  ownerId: process.env.SEALANT_OWNER_USER_ID,
  ownerEmail: process.env.SEALANT_OWNER_EMAIL,
  ownerName: process.env.SEALANT_OWNER_NAME,
  devSshPublicKeyPath:
    process.env.SEALANT_DEV_SSH_PUBLIC_KEY_FILE ??
    resolve(repoRoot, ".secrets", "dev_client_key.pub"),
});
