import { describe, expect, it } from "@effect/vitest";
import type { CredentialCipherService } from "@sealant/credentials";
import { sha256Hex } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  type ConnectedAccount,
  type ConnectedAccountRepoService,
} from "@sealant/db";
import { newWorkspaceSchema, type NewWorkspace } from "@sealant/validators";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import {
  isNewerClaudeCredentials,
  readStoredClaudeExpiresAt,
  syncBackClaudeCredentials,
} from "./claude-credentials-sync-back.js";

const fakeCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

const credentialsJsonWithExpiry = (expiresAt: number): string =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-rotated-wxyz",
      refreshToken: "sk-ant-ort01-rotated",
      expiresAt,
      scopes: ["user:inference"],
      subscriptionType: "max",
    },
  });

const STORED_EXPIRES_AT = 1_750_000_000_000;

const storedFilePayload = (expiresAt: number = STORED_EXPIRES_AT): string =>
  `sealed:${JSON.stringify({ credentialsJson: credentialsJsonWithExpiry(expiresAt) })}`;

const createClaudeAccount = (overrides: Partial<ConnectedAccount> = {}): ConnectedAccount =>
  ({
    id: "cacc_claude",
    ownerUserId: "usr_1",
    provider: "claude",
    name: "default",
    kind: "credentials-json",
    status: "active",
    encryptedPayload: storedFilePayload(),
    encryptionKeyId: "k-test",
    payloadSha256: "old-sha",
    metadata: { expiresAt: STORED_EXPIRES_AT, subscriptionType: "max", tokenSuffix: "wxyz" },
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    lastUsedAt: null,
    lastSyncedAt: null,
    invalidAt: null,
    archivedAt: null,
    ...overrides,
  }) as ConnectedAccount;

const connectedAccountRepoStub = (account: ConnectedAccount | undefined) => ({
  getById: vi.fn((_id: string) => Effect.succeed(account)),
  replacePayload: vi.fn((_input: unknown) => Effect.succeed(account)),
  updateSyncState: vi.fn((_input: unknown) => Effect.succeed(account)),
});

const provideAccounts = (stub: unknown) =>
  Layer.succeed(ConnectedAccountRepo, stub as ConnectedAccountRepoService);

const claudeBlueprint: NewWorkspace = newWorkspaceSchema.parse({
  sources: { workspace: { url: "https://github.com/example/repo.git" } },
  harness: { id: "opencode" },
  runtime: { credentialRefs: [{ provider: "claude", ref: "connected-account:cacc_claude" }] },
});

const noClaudeBlueprint: NewWorkspace = newWorkspaceSchema.parse({
  sources: { workspace: { url: "https://github.com/example/repo.git" } },
  harness: { id: "opencode" },
});

describe("isNewerClaudeCredentials", () => {
  it("never persists when the observed file has no expiresAt", () => {
    expect(
      isNewerClaudeCredentials({ observedExpiresAt: undefined, storedExpiresAt: undefined }),
    ).toBe(false);
    expect(isNewerClaudeCredentials({ observedExpiresAt: undefined, storedExpiresAt: 100 })).toBe(
      false,
    );
  });

  it("persists a first-ever expiry", () => {
    expect(isNewerClaudeCredentials({ observedExpiresAt: 100, storedExpiresAt: undefined })).toBe(
      true,
    );
  });

  it("persists only strictly newer expiries (rotated-session safety)", () => {
    expect(isNewerClaudeCredentials({ observedExpiresAt: 200, storedExpiresAt: 100 })).toBe(true);
    // Equal must NOT write.
    expect(isNewerClaudeCredentials({ observedExpiresAt: 100, storedExpiresAt: 100 })).toBe(false);
    // Older must NOT write.
    expect(isNewerClaudeCredentials({ observedExpiresAt: 50, storedExpiresAt: 100 })).toBe(false);
  });
});

describe("readStoredClaudeExpiresAt", () => {
  it("reads a numeric expiresAt and rejects everything else", () => {
    expect(readStoredClaudeExpiresAt({ expiresAt: 123 })).toBe(123);
    expect(readStoredClaudeExpiresAt({ expiresAt: "123" })).toBeUndefined();
    expect(readStoredClaudeExpiresAt({ expiresAt: Number.NaN })).toBeUndefined();
    expect(readStoredClaudeExpiresAt({})).toBeUndefined();
    expect(readStoredClaudeExpiresAt(null)).toBeUndefined();
  });
});

describe("syncBackClaudeCredentials", () => {
  it.effect(
    "persists a strictly newer .credentials.json with merged metadata and sync bookkeeping",
    () => {
      const accounts = connectedAccountRepoStub(createClaudeAccount());
      const rotated = credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000);

      return Effect.gen(function* () {
        yield* syncBackClaudeCredentials({
          blueprint: claudeBlueprint,
          credentialCipher: fakeCipher,
          readCredentialsJson: () => Effect.succeed(rotated),
        });

        const expectedPlaintext = JSON.stringify({ credentialsJson: rotated });
        expect(accounts.replacePayload).toHaveBeenCalledWith({
          id: "cacc_claude",
          kind: "credentials-json",
          encryptedPayload: `sealed:${expectedPlaintext}`,
          encryptionKeyId: "k-test",
          payloadSha256: sha256Hex(expectedPlaintext),
          metadata: expect.objectContaining({
            expiresAt: STORED_EXPIRES_AT + 1_000,
            subscriptionType: "max",
            tokenSuffix: "wxyz",
          }),
        });
        expect(accounts.updateSyncState).toHaveBeenCalledWith(
          expect.objectContaining({ id: "cacc_claude", lastSyncedAt: expect.any(Date) }),
        );
      }).pipe(Effect.provide(provideAccounts(accounts)));
    },
  );

  it.effect("never writes when the observed expiry is equal to the stored one", () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount());

    return Effect.gen(function* () {
      yield* syncBackClaudeCredentials({
        blueprint: claudeBlueprint,
        credentialCipher: fakeCipher,
        readCredentialsJson: () => Effect.succeed(credentialsJsonWithExpiry(STORED_EXPIRES_AT)),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
      expect(accounts.updateSyncState).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("never writes when the observed expiry is older than the stored one", () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount());

    return Effect.gen(function* () {
      yield* syncBackClaudeCredentials({
        blueprint: claudeBlueprint,
        credentialCipher: fakeCipher,
        readCredentialsJson: () =>
          Effect.succeed(credentialsJsonWithExpiry(STORED_EXPIRES_AT - 1_000)),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("skips setup-token accounts entirely (shape-dispatched, never converted)", () => {
    const accounts = connectedAccountRepoStub(
      createClaudeAccount({
        kind: "oauth-token",
        encryptedPayload: `sealed:${JSON.stringify({ token: "sk-ant-oat01-test" })}`,
        metadata: { tokenSuffix: "test" },
      }),
    );

    return Effect.gen(function* () {
      yield* syncBackClaudeCredentials({
        blueprint: claudeBlueprint,
        credentialCipher: fakeCipher,
        readCredentialsJson: () =>
          Effect.succeed(credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000)),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
      expect(accounts.updateSyncState).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("skips (with a warning, not a failure) when the file cannot be read", () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount());

    return Effect.gen(function* () {
      yield* syncBackClaudeCredentials({
        blueprint: claudeBlueprint,
        credentialCipher: fakeCipher,
        readCredentialsJson: () => Effect.fail(new Error("container is gone")),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("skips when the observed .credentials.json is invalid", () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount());

    return Effect.gen(function* () {
      yield* syncBackClaudeCredentials({
        blueprint: claudeBlueprint,
        credentialCipher: fakeCipher,
        readCredentialsJson: () => Effect.succeed("{ this is not json"),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("no-ops without touching the repo when the blueprint has no claude ref", () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount());
    const readCredentialsJson = vi.fn(() =>
      Effect.succeed(credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000)),
    );

    return Effect.gen(function* () {
      yield* syncBackClaudeCredentials({
        blueprint: noClaudeBlueprint,
        credentialCipher: fakeCipher,
        readCredentialsJson,
      });

      expect(readCredentialsJson).not.toHaveBeenCalled();
      expect(accounts.getById).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("skips when the connected account has been archived since launch", () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount({ archivedAt: new Date() }));

    return Effect.gen(function* () {
      yield* syncBackClaudeCredentials({
        blueprint: claudeBlueprint,
        credentialCipher: fakeCipher,
        readCredentialsJson: () =>
          Effect.succeed(credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000)),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("degrades to a warning when the repo write fails", () => {
    const accounts = {
      getById: vi.fn((_id: string) => Effect.succeed(createClaudeAccount())),
      replacePayload: vi.fn((_input: unknown) => Effect.fail(new Error("db down"))),
      updateSyncState: vi.fn((_input: unknown) => Effect.succeed(undefined)),
    };

    return Effect.gen(function* () {
      // Must not fail even though replacePayload does.
      yield* syncBackClaudeCredentials({
        blueprint: claudeBlueprint,
        credentialCipher: fakeCipher,
        readCredentialsJson: () =>
          Effect.succeed(credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000)),
      });

      expect(accounts.updateSyncState).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });
});
