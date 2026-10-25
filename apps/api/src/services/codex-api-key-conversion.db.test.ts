import { randomUUID } from "node:crypto";

import {
  codexLoginFile,
  CredentialCipher,
  parseCodexCredentialPayload,
  sha256Hex,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  createSealantDB,
  CredentialPlacementRepoLive,
  SealantDB,
  user,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

let conversion: typeof import("./codex-api-key-conversion.js");
let accountsModule: typeof import("../routes/connected-accounts/connected-accounts.module.js");

let decrypted = 0;
const fakeCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) =>
    Effect.sync(() => {
      decrypted += 1;
      return sealed.slice("sealed:".length);
    }),
};

const codexKey = "sk-proj-FAKEcodexkeyforthetests0000wxyz";

describe.skipIf(DATABASE_URL === undefined)(
  "Codex rows that held a key in an auth.json (Postgres)",
  () => {
    let db: DB;

    beforeAll(async () => {
      conversion = await import("./codex-api-key-conversion.js");
      accountsModule = await import("../routes/connected-accounts/connected-accounts.module.js");
      db = await createSealantDB(DATABASE_URL ?? "");
    });

    const layer = () =>
      Layer.merge(ConnectedAccountRepoLive, CredentialPlacementRepoLive).pipe(
        Layer.provideMerge(Layer.succeed(SealantDB, db)),
        Layer.provideMerge(Layer.succeed(CredentialCipher, fakeCipher)),
      );
    const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layer>>>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer())));

    const legacy = async (
      authJson: unknown,
      status: { readonly archived?: boolean; readonly invalid?: boolean } = {},
    ) => {
      const owner = `user_legacy_${randomUUID()}`;
      await Effect.runPromise(
        db.insert(user).values({ id: owner, name: "legacy", email: `${owner}@example.test` }),
      );
      const plaintext = JSON.stringify({ authJson: JSON.stringify(authJson) });
      return run(
        Effect.flatMap(ConnectedAccountRepo, (accounts) =>
          Effect.gen(function* () {
            const created = yield* accounts.createConnectedAccount({
              id: `cacc_${randomUUID()}`,
              ownerUserId: owner,
              provider: "codex",
              name: "default",
              kind: "auth-json",
              encryptedPayload: `sealed:${plaintext}`,
              encryptionKeyId: "k-test",
              payloadSha256: sha256Hex(plaintext),
              metadata: { authMode: "apikey" },
            });
            yield* accounts.setDefault({
              ownerUserId: owner,
              provider: "codex",
              connectedAccountId: created.id,
            });
            if (status.invalid === true) yield* accounts.markInvalid({ id: created.id });
            if (status.archived === true) {
              yield* accounts.archiveAndClearDefault({ id: created.id, ownerUserId: owner });
            }
            // As the migration marks every Codex auth.json row stored before keys had a kind.
            yield* db.execute(
              `update connected_accounts set kind_unchecked = true where id = '${created.id}'`,
            );
            return created;
          }),
        ),
      );
    };
    const stored = (id: string) =>
      run(Effect.flatMap(ConnectedAccountRepo, (accounts) => accounts.getById(id)));
    const placed = async (id: string) => {
      const row = await stored(id);
      return codexLoginFile(
        parseCodexCredentialPayload(
          JSON.parse((row?.encryptedPayload ?? "").slice("sealed:".length)),
        ),
      );
    };

    it("re-seals each as the key alone, once, keeping its status and default and its placement", async () => {
      const active = await legacy({ OPENAI_API_KEY: codexKey, tokens: null });
      const invalid = await legacy(
        { auth_mode: "apikey", OPENAI_API_KEY: codexKey },
        { invalid: true },
      );
      const archived = await legacy({ OPENAI_API_KEY: codexKey }, { archived: true });
      const chatgpt = await legacy({
        auth_mode: "chatgpt",
        tokens: { access_token: "at-fake", refresh_token: "rt-fake" },
        OPENAI_API_KEY: codexKey,
      });
      const refused = await legacy({ OPENAI_API_KEY: "sk-ant-api03-FAKEunderthewrongprovider00" });
      const chatgptBefore = await stored(chatgpt.id);
      const before = await placed(active.id);
      expect(JSON.parse(before)).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: codexKey });

      await run(conversion.convertLegacyCodexApiKeys);

      for (const [row, status] of [
        [active, "active"],
        [invalid, "invalid"],
        [archived, "archived"],
      ] as const) {
        const after = await stored(row.id);
        expect(after).toMatchObject({
          kind: "api-key",
          kindUnchecked: false,
          apiKeyConnectedAt: expect.any(Date),
          status,
          credentialRevision: 2,
          isDefault: status !== "archived",
          metadata: { authMode: "apikey", tokenSuffix: "wxyz" },
        });
        expect(JSON.parse((after?.encryptedPayload ?? "").slice("sealed:".length))).toEqual({
          apiKey: codexKey,
        });
        expect(await placed(row.id)).toBe(before);
      }
      expect(await stored(chatgpt.id)).toMatchObject({
        kind: "auth-json",
        kindUnchecked: false,
        credentialRevision: 1,
        encryptedPayload: chatgptBefore?.encryptedPayload,
      });
      expect(await stored(refused.id)).toMatchObject({
        kind: "auth-json",
        kindUnchecked: true,
        credentialRevision: 1,
      });

      decrypted = 0;
      expect(await run(conversion.convertLegacyCodexApiKeys)).toBe(0);
      expect(await stored(active.id)).toMatchObject({ kind: "api-key", credentialRevision: 2 });
      expect(decrypted).toBe(1);

      const history = await run(
        accountsModule.listConnectedAccounts({ ownerUserId: archived.ownerUserId }),
      );
      expect(history).toEqual({ items: [], hasApiKeyHistory: true });
      const summary = await run(
        accountsModule.listConnectedAccounts({ ownerUserId: active.ownerUserId }),
      );
      expect(summary.items).toEqual([
        expect.objectContaining({ kind: "api-key", login: { kind: "api-key", suffix: "wxyz" } }),
      ]);
    });

    it("records a converted key's placements, and a refused key's, as keys; a ChatGPT login's stay", async () => {
      const key = await legacy({ OPENAI_API_KEY: codexKey, tokens: null });
      const refused = await legacy({ OPENAI_API_KEY: "sk-ant-api03-FAKEunderthewrongprovider00" });
      const chatgpt = await legacy({
        auth_mode: "chatgpt",
        tokens: { access_token: "at-fake", refresh_token: "rt-fake" },
      });
      const runId = `run_conversion_${randomUUID()}`;
      const statements = [
        `insert into workspace_attempts (id, owner_user_id, queued_at, created_at, updated_at)
           values ('${runId}', '${key.ownerUserId}', now(), now(), now())`,
        `insert into workspace_runtime_instances (run_id, status, created_at, updated_at)
           values ('${runId}', 'ready', now(), now())`,
        ...[key, refused, chatgpt].map(
          (account, index) =>
            `insert into workspace_credential_homes (run_id, home, on_behalf_of_user_id, generation, created_at, updated_at)
               values ('${runId}', '/home/h${String(index)}', '${account.ownerUserId}', 'gen-${String(index)}', now(), now())`,
        ),
        ...[key, refused, chatgpt].map(
          (account, index) =>
            `insert into workspace_credential_placements (id, run_id, home, provider, account_id, revision, path, login, state, created_at)
               values ('cpl_${account.id}', '${runId}', '/home/h${String(index)}', 'codex', '${account.id}', 1, '/home/h${String(index)}/.codex/auth.json', '{"kind":"subscription"}'::jsonb, 'ready', now())`,
        ),
      ];
      for (const statement of statements) await Effect.runPromise(db.execute(statement));

      await run(conversion.convertLegacyCodexApiKeys);
      await run(conversion.convertLegacyCodexApiKeys);

      const logins = await Effect.runPromise(
        db.execute<{ readonly account_id: string; readonly login: unknown }>(
          `select account_id, login from workspace_credential_placements where run_id = '${runId}'`,
          "objects",
        ),
      );
      expect(new Map(logins.map((row) => [row.account_id, row.login]))).toEqual(
        new Map([
          [key.id, { kind: "api-key", suffix: "wxyz" }],
          [refused.id, { kind: "api-key", suffix: "er00" }],
          [chatgpt.id, { kind: "subscription" }],
        ]),
      );
    });
  },
);
