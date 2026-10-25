import { randomUUID } from "node:crypto";

import {
  parseClaudeCredentialPayload,
  parseCodexCredentialPayload,
  sha256Hex,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  createSealantDB,
  SealantDB,
  user,
  WorkspaceCredentialHomeRepoLive,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { persistClaudeCredentialsIfNewer, persistCodexAuthJsonIfNewer } from "@sealant/workspaces";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { refreshClaudeSessionAccount } from "./refresh-claude-sessions.js";
import { refreshCodexSessionAccount } from "./refresh-codex-sessions.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const fakeCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

const HOUR = 3_600_000;
const codexKey = "sk-proj-FAKEcodexkeyforthetests0000wxyz";
const claudeKey = "sk-ant-api03-FAKEclaudekeyforthetests000000wxyz";

describe.skipIf(DATABASE_URL === undefined)(
  "an API key is never refreshed or written back (Postgres)",
  () => {
    let db: DB;

    beforeAll(async () => {
      db = await createSealantDB(DATABASE_URL ?? "");
    });

    const layer = () =>
      Layer.mergeAll(
        ConnectedAccountRepoLive,
        WorkspaceRuntimeInstanceRepoLive,
        WorkspaceCredentialHomeRepoLive,
      ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));
    const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layer>>>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer())));

    const account = async (provider: "claude" | "codex", kind: string, payload: unknown) => {
      const owner = `user_key_${randomUUID()}`;
      await Effect.runPromise(
        db.insert(user).values({ id: owner, name: "key", email: `${owner}@example.test` }),
      );
      const plaintext = JSON.stringify(payload);
      return run(
        Effect.flatMap(ConnectedAccountRepo, (accounts) =>
          accounts.createConnectedAccount({
            id: `cacc_${randomUUID()}`,
            ownerUserId: owner,
            provider,
            name: "default",
            kind,
            encryptedPayload: `sealed:${plaintext}`,
            encryptionKeyId: "k-test",
            payloadSha256: sha256Hex(plaintext),
            metadata: { tokenSuffix: "wxyz" },
          }),
        ),
      );
    };
    const stored = (id: string) =>
      run(Effect.flatMap(ConnectedAccountRepo, (accounts) => accounts.getById(id)));
    const listed = (provider: "claude" | "codex", kind: string) =>
      run(
        Effect.flatMap(ConnectedAccountRepo, (accounts) =>
          accounts.listActiveByProviderKind({ provider, kind }),
        ),
      ).then((rows) => rows.map((row) => row.id));
    const untouched = async (before: { readonly id: string; readonly provider: string }) => {
      const after = await stored(before.id);
      expect(after).toMatchObject({ refreshClaimedUntil: null, lastSyncedAt: null });
      expect(after?.metadata).not.toHaveProperty("lastRefreshOutcome");
      const plaintext = JSON.parse((after?.encryptedPayload ?? "").slice("sealed:".length));
      expect(
        before.provider === "codex"
          ? parseCodexCredentialPayload(plaintext)
          : parseClaudeCredentialPayload(plaintext),
      ).toEqual({ apiKey: before.provider === "codex" ? codexKey : claudeKey });
    };

    it("the Codex sweeper never lists a key, and skips a key stored as an auth.json", async () => {
      const key = await account("codex", "api-key", { apiKey: codexKey });
      const legacy = await account("codex", "auth-json", {
        authJson: JSON.stringify({ OPENAI_API_KEY: codexKey, tokens: null }),
      });
      const candidates = await listed("codex", "auth-json");
      expect(candidates).not.toContain(key.id);
      for (const row of [key, legacy]) {
        expect(
          await run(
            refreshCodexSessionAccount({
              account: row,
              credentialCipher: fakeCipher,
              targetOptions: {},
              now: Date.now(),
            }),
          ),
        ).toBe("skipped");
        await untouched(row);
      }
    });

    it("the Claude sweeper never lists a key, and skips one handed to it", async () => {
      const key = await account("claude", "api-key", { apiKey: claudeKey });
      expect(await listed("claude", "credentials-json")).not.toContain(key.id);
      expect(
        await run(
          refreshClaudeSessionAccount({
            account: key,
            credentialCipher: fakeCipher,
            targetOptions: {},
            now: Date.now(),
          }),
        ),
      ).toBe("skipped");
      await untouched(key);
    });

    it("a login read back from a workspace never replaces a key", async () => {
      const codex = await account("codex", "api-key", { apiKey: codexKey });
      const legacy = await account("codex", "auth-json", {
        authJson: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: codexKey }),
      });
      const chatgpt = JSON.stringify({
        tokens: { access_token: "at-fake", refresh_token: "rt-fake", account_id: "acct" },
        last_refresh: new Date().toISOString(),
      });
      for (const row of [codex, legacy]) {
        expect(
          await run(
            persistCodexAuthJsonIfNewer({
              connectedAccountId: row.id,
              observedAuthJson: chatgpt,
              credentialCipher: fakeCipher,
              source: "test",
              sourceRevision: "unknown",
            }),
          ),
        ).toBe("skipped-api-key");
        await untouched(row);
      }

      const claude = await account("claude", "api-key", { apiKey: claudeKey });
      const session = JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-fake",
          refreshToken: "sk-ant-ort01-fake",
          expiresAt: Date.now() + 8 * HOUR,
        },
      });
      expect(
        await run(
          persistClaudeCredentialsIfNewer({
            connectedAccountId: claude.id,
            observedCredentialsJson: session,
            credentialCipher: fakeCipher,
            source: "test",
            sourceRevision: "unknown",
          }),
        ),
      ).toBe("skipped-api-key");
      await untouched(claude);
    });

    it("a read-back login that spends a key never replaces a subscription", async () => {
      const authJson = JSON.stringify({
        tokens: { access_token: "at-fake", refresh_token: "rt-fake", account_id: "acct" },
        last_refresh: "2026-10-01T00:00:00.000Z",
      });
      const subscription = await account("codex", "auth-json", { authJson });
      const spendsKey = JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: codexKey,
        tokens: { access_token: "at-new", refresh_token: "rt-new", account_id: "acct" },
        last_refresh: new Date().toISOString(),
      });
      expect(
        await run(
          persistCodexAuthJsonIfNewer({
            connectedAccountId: subscription.id,
            observedAuthJson: spendsKey,
            credentialCipher: fakeCipher,
            source: "test",
            sourceRevision: "unknown",
          }),
        ),
      ).toBe("skipped-api-key");
      const after = await stored(subscription.id);
      expect(JSON.parse((after?.encryptedPayload ?? "").slice("sealed:".length))).toEqual({
        authJson,
      });
    });
  },
);
