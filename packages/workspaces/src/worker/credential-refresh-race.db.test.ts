/**
 * A refresh that started before a reconnect must not overwrite it, against a REAL Postgres: the
 * sweeper read the login at credential revision 1, the person reconnected (revision 2), and the
 * refreshed revision-1 file, however much newer, is not stored. Gated on SEALANT_TEST_DATABASE_URL
 * (a disposable database with the migrations applied; it writes rows under fresh ids and leaves them).
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/worker/credential-refresh-race.db.test.ts
 */
import { randomUUID } from "node:crypto";

import { sha256Hex, type CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  createSealantDB,
  SealantDB,
  user,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { persistClaudeCredentialsIfNewer } from "./claude-credentials-sync-back.js";
import { persistCodexAuthJsonIfNewer } from "./codex-auth-sync-back.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const fakeCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

const HOUR = 3_600_000;

const claudeFile = (label: string, expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat01-fake-${label}`,
      refreshToken: `sk-ant-ort01-fake-${label}`,
      expiresAt,
      scopes: ["user:inference"],
    },
  });

const codexFile = (label: string, lastRefresh: string) =>
  JSON.stringify({
    tokens: { refresh_token: `rt-fake-${label}`, account_id: `acct-${label}` },
    last_refresh: lastRefresh,
  });

describe.skipIf(DATABASE_URL === undefined)("a refresh racing a reconnect (Postgres)", () => {
  let db: DB;

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
  });

  const run = <A, E>(effect: Effect.Effect<A, E, ConnectedAccountRepo>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(ConnectedAccountRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db)))),
      ),
    );

  const account = async (input: {
    readonly provider: "claude" | "codex";
    readonly kind: string;
    readonly payload: string;
  }) => {
    const owner = `user_race_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(user).values({ id: owner, name: "race", email: `${owner}@example.test` }),
    );
    return run(
      Effect.flatMap(ConnectedAccountRepo, (accounts) =>
        accounts.createConnectedAccount({
          id: `cacc_${randomUUID()}`,
          ownerUserId: owner,
          provider: input.provider,
          name: "default",
          kind: input.kind,
          encryptedPayload: `sealed:${input.payload}`,
          encryptionKeyId: "k-test",
          payloadSha256: sha256Hex(input.payload),
          metadata: {},
        }),
      ),
    );
  };

  const reconnect = (id: string, payload: string) =>
    run(
      Effect.flatMap(ConnectedAccountRepo, (accounts) =>
        accounts.replacePayload({
          id,
          encryptedPayload: `sealed:${payload}`,
          encryptionKeyId: "k-test",
          payloadSha256: sha256Hex(payload),
          metadata: {},
        }),
      ),
    );

  const stored = (id: string) =>
    run(Effect.flatMap(ConnectedAccountRepo, (accounts) => accounts.getById(id)));

  it("keeps the reconnected Claude login when the old one's refresh comes back", async () => {
    const now = Date.now();
    const first = await account({
      provider: "claude",
      kind: "credentials-json",
      payload: JSON.stringify({ credentialsJson: claudeFile("a", now - HOUR) }),
    });
    expect(first.credentialRevision).toBe(1);
    const reconnected = JSON.stringify({ credentialsJson: claudeFile("b", now + HOUR) });
    expect((await reconnect(first.id, reconnected))?.credentialRevision).toBe(2);

    const outcome = await run(
      persistClaudeCredentialsIfNewer({
        connectedAccountId: first.id,
        observedCredentialsJson: claudeFile("a-refreshed", now + 8 * HOUR),
        credentialCipher: fakeCipher,
        source: "test",
        sourceRevision: first.credentialRevision,
      }),
    );

    expect(outcome).toBe("skipped-superseded");
    expect(await stored(first.id)).toMatchObject({
      encryptedPayload: `sealed:${reconnected}`,
      credentialRevision: 2,
    });
  });

  it("keeps the reconnected Codex login when the old one's refresh comes back", async () => {
    const first = await account({
      provider: "codex",
      kind: "auth-json",
      payload: JSON.stringify({ authJson: codexFile("a", "2026-10-01T00:00:00.000Z") }),
    });
    const reconnected = JSON.stringify({ authJson: codexFile("b", "2026-10-02T00:00:00.000Z") });
    await reconnect(first.id, reconnected);

    const outcome = await run(
      persistCodexAuthJsonIfNewer({
        connectedAccountId: first.id,
        observedAuthJson: codexFile("a-refreshed", "2026-10-03T00:00:00.000Z"),
        credentialCipher: fakeCipher,
        source: "test",
        sourceRevision: first.credentialRevision,
      }),
    );

    expect(outcome).toBe("skipped-superseded");
    expect(await stored(first.id)).toMatchObject({
      encryptedPayload: `sealed:${reconnected}`,
      credentialRevision: 2,
    });
  });

  it("stores a refresh of the credential that is still there", async () => {
    const now = Date.now();
    const first = await account({
      provider: "claude",
      kind: "credentials-json",
      payload: JSON.stringify({ credentialsJson: claudeFile("a", now - HOUR) }),
    });

    const outcome = await run(
      persistClaudeCredentialsIfNewer({
        connectedAccountId: first.id,
        observedCredentialsJson: claudeFile("a-refreshed", now + 8 * HOUR),
        credentialCipher: fakeCipher,
        source: "test",
        sourceRevision: first.credentialRevision,
      }),
    );

    expect(outcome).toBe("synced");
    expect((await stored(first.id))?.credentialRevision).toBe(2);
  });

  it("writes no payload over a revision it no longer holds", async () => {
    const first = await account({ provider: "claude", kind: "oauth-token", payload: "one" });
    await reconnect(first.id, "two");

    const stale = await run(
      Effect.flatMap(ConnectedAccountRepo, (accounts) =>
        accounts.replacePayload({
          id: first.id,
          encryptedPayload: "sealed:three",
          encryptionKeyId: "k-test",
          payloadSha256: sha256Hex("three"),
          metadata: {},
          expectedRevision: 1,
        }),
      ),
    );

    expect(stale).toBeUndefined();
    expect(await stored(first.id)).toMatchObject({
      encryptedPayload: "sealed:two",
      credentialRevision: 2,
    });
  });
});
