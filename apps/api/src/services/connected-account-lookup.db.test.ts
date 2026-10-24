import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ConnectedAccountRepoLive,
  createSealantDB,
  SealantDB,
  user,
  type ConnectedAccountProvider,
  type DB,
} from "@sealant/db";
import { runMigrations } from "@sealant/db/migrate";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveSelectedConnectedAccount } from "../routes/workspaces/connected-account-selection.js";
import { lookupConnectedAccount } from "./connected-account-lookup.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
const POINTER_MIGRATION = "20261024184909_connected_account_defaults";

const migrationsFolder = join(
  dirname(createRequire(import.meta.url).resolve("@sealant/db/migrate")),
  "..",
  "drizzle",
);

const silent = () => {};

const insertAccount = (
  id: string,
  owner: string,
  provider: ConnectedAccountProvider,
  name: string,
  status: "active" | "invalid" | "archived",
) =>
  `insert into connected_accounts (id, owner_user_id, provider, name, kind, status,
     encrypted_payload, encryption_key_id, payload_sha256, metadata, created_at, updated_at,
     archived_at)
   values ('${id}', '${owner}', '${provider}', '${name}', 'oauth-token', '${status}', 'sealed',
     'k-test', 'sha', '{}'::jsonb, now(), now(), ${status === "archived" ? "now()" : "null"})`;

describe.skipIf(DATABASE_URL === undefined)("the default-pointer migration (Postgres)", () => {
  const databaseName = `sealant_pointer_${randomUUID().replaceAll("-", "")}`;
  const admin = new URL(DATABASE_URL ?? "postgresql://unused");
  const fresh = new URL(admin);
  fresh.pathname = `/${databaseName}`;
  let adminDb: DB;
  let db: DB;
  let before: Map<string, string | undefined>;

  const seeded = {
    aliceClaude: "cacc_alice_claude",
    aliceClaudeWork: "cacc_alice_claude_work",
    aliceCodexInvalid: "cacc_alice_codex",
    bobClaudeWork: "cacc_bob_claude_work",
    carolArchived: "cacc_carol_archived",
    carolClaude: "cacc_carol_claude",
    daveGithub: "cacc_dave_github",
  };
  const selections: ReadonlyArray<readonly [string, ConnectedAccountProvider]> = [
    ["alice", "claude"],
    ["alice", "codex"],
    ["bob", "claude"],
    ["carol", "claude"],
    ["dave", "github"],
  ];

  beforeAll(async () => {
    adminDb = await createSealantDB(admin.toString());
    await Effect.runPromise(adminDb.execute(`CREATE DATABASE "${databaseName}"`));

    const earlier = mkdtempSync(join(tmpdir(), "sealant-migrations-"));
    for (const entry of readdirSync(migrationsFolder)) {
      if (entry !== POINTER_MIGRATION) {
        cpSync(join(migrationsFolder, entry), join(earlier, entry), { recursive: true });
      }
    }
    await runMigrations({ databaseUrl: fresh.toString(), migrationsFolder: earlier, log: silent });
    rmSync(earlier, { recursive: true, force: true });

    db = await createSealantDB(fresh.toString());
    for (const id of ["alice", "bob", "carol", "dave"]) {
      await Effect.runPromise(
        db.insert(user).values({ id, name: id, email: `${id}@example.test` }),
      );
    }
    for (const statement of [
      insertAccount(seeded.aliceClaude, "alice", "claude", "default", "active"),
      insertAccount(seeded.aliceClaudeWork, "alice", "claude", "work", "active"),
      insertAccount(seeded.aliceCodexInvalid, "alice", "codex", "default", "invalid"),
      insertAccount(seeded.bobClaudeWork, "bob", "claude", "work", "active"),
      insertAccount(seeded.carolArchived, "carol", "claude", "default", "archived"),
      insertAccount(seeded.carolClaude, "carol", "claude", "default", "active"),
      insertAccount(seeded.daveGithub, "dave", "github", "default", "active"),
    ]) {
      await Effect.runPromise(db.execute(statement));
    }

    before = new Map();
    for (const [owner, provider] of selections) {
      const rows = await Effect.runPromise(
        db.execute<{ readonly id: string }>(
          `select id from connected_accounts where owner_user_id = '${owner}'
             and provider = '${provider}' and name = 'default' and archived_at is null`,
          "objects",
        ),
      );
      before.set(`${owner} ${provider}`, rows[0]?.id);
    }

    const { applied } = await runMigrations({
      databaseUrl: fresh.toString(),
      migrationsFolder,
      log: silent,
    });
    expect(applied).toEqual([POINTER_MIGRATION]);
  }, 120_000);

  afterAll(async () => {
    if (adminDb !== undefined) {
      await Effect.runPromise(
        adminDb.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`),
      );
    }
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof ConnectedAccountRepoLive>>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(ConnectedAccountRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db)))),
      ),
    );

  it("answers `default` with the account the name lookup answered before", async () => {
    expect(Object.fromEntries(before)).toEqual({
      "alice claude": seeded.aliceClaude,
      "alice codex": seeded.aliceCodexInvalid,
      "bob claude": undefined,
      "carol claude": seeded.carolClaude,
      "dave github": seeded.daveGithub,
    });
    for (const [owner, provider] of selections) {
      const lookup = await run(
        lookupConnectedAccount({ ownerUserId: owner, provider, selection: "default" }),
      );
      const id = lookup.kind === "missing" ? undefined : lookup.account.id;
      expect(id, `${owner} ${provider}`).toBe(before.get(`${owner} ${provider}`));
    }
  });

  it("keeps an invalid default invalid, and a person without one without one", async () => {
    const invalid = await run(
      Effect.flip(
        resolveSelectedConnectedAccount({
          ownerUserId: "alice",
          provider: "codex",
          selection: "default",
        }),
      ),
    );
    expect(invalid).toMatchObject({ code: "connected-account-invalid", provider: "codex" });
    const missing = await run(
      Effect.flip(
        resolveSelectedConnectedAccount({
          ownerUserId: "bob",
          provider: "claude",
          selection: "default",
        }),
      ),
    );
    expect(missing).toMatchObject({ code: "connected-account-missing", provider: "claude" });
    const named = await run(
      resolveSelectedConnectedAccount({
        ownerUserId: "bob",
        provider: "claude",
        selection: "work",
      }),
    );
    expect(named.id).toBe(seeded.bobClaudeWork);
  });

  it("starts every account at credential revision 1", async () => {
    const rows = await Effect.runPromise(
      db.execute<{ readonly revision: number }>(
        "select distinct credential_revision as revision from connected_accounts",
        "objects",
      ),
    );
    expect(rows).toEqual([{ revision: 1 }]);
  });
});
