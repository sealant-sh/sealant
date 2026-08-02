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
  persistClaudeCredentialsIfNewer,
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

/*
The pure freshness guards (isNewerClaudeCredentials, isPlausibleClaudeExpiry,
readStoredClaudeExpiresAt) moved to @sealant/credentials — their unit tests live in
packages/credentials/src/claude-session.test.ts. Here we test the shared persist core and the
workspace sync-back orchestration on top of it.
*/

describe("persistClaudeCredentialsIfNewer", () => {
  const persist = (input: { readonly accounts: unknown; readonly observed: string }) =>
    Effect.runPromise(
      persistClaudeCredentialsIfNewer({
        connectedAccountId: "cacc_claude",
        observedCredentialsJson: input.observed,
        credentialCipher: fakeCipher,
        source: "test",
      }).pipe(Effect.provide(provideAccounts(input.accounts))),
    );

  it("returns synced and writes when the observed file is strictly newer", async () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount());
    const outcome = await persist({
      accounts,
      observed: credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000),
    });
    expect(outcome).toBe("synced");
    expect(accounts.replacePayload).toHaveBeenCalledOnce();
    expect(accounts.updateSyncState).toHaveBeenCalledOnce();
  });

  it("returns skipped-not-newer for equal or older files, without writing", async () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount());
    expect(
      await persist({ accounts, observed: credentialsJsonWithExpiry(STORED_EXPIRES_AT) }),
    ).toBe("skipped-not-newer");
    expect(
      await persist({ accounts, observed: credentialsJsonWithExpiry(STORED_EXPIRES_AT - 1_000) }),
    ).toBe("skipped-not-newer");
    expect(accounts.replacePayload).not.toHaveBeenCalled();
  });

  it("returns skipped-invalid-file for unparseable content", async () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount());
    expect(await persist({ accounts, observed: "{ this is not json" })).toBe(
      "skipped-invalid-file",
    );
    expect(accounts.getById).not.toHaveBeenCalled();
  });

  it("returns skipped-implausible-expiry for sentinel expiries (30-day belt)", async () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount());
    expect(
      await persist({ accounts, observed: credentialsJsonWithExpiry(9_999_999_999_999) }),
    ).toBe("skipped-implausible-expiry");
    expect(accounts.replacePayload).not.toHaveBeenCalled();
  });

  it("returns skipped-not-session-file for setup-token accounts (never converted)", async () => {
    const accounts = connectedAccountRepoStub(
      createClaudeAccount({
        kind: "oauth-token",
        encryptedPayload: `sealed:${JSON.stringify({ token: "sk-ant-oat01-test" })}`,
        metadata: { tokenSuffix: "test" },
      }),
    );
    expect(
      await persist({ accounts, observed: credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000) }),
    ).toBe("skipped-not-session-file");
    expect(accounts.replacePayload).not.toHaveBeenCalled();
  });

  it("returns skipped-account-unavailable for archived accounts", async () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount({ archivedAt: new Date() }));
    expect(
      await persist({ accounts, observed: credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000) }),
    ).toBe("skipped-account-unavailable");
    expect(accounts.replacePayload).not.toHaveBeenCalled();
  });

  it("returns failed (never throws) when the repo write fails", async () => {
    const accounts = {
      getById: vi.fn((_id: string) => Effect.succeed(createClaudeAccount())),
      replacePayload: vi.fn((_input: unknown) => Effect.fail(new Error("db down"))),
      updateSyncState: vi.fn((_input: unknown) => Effect.succeed(undefined)),
    };
    expect(
      await persist({ accounts, observed: credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000) }),
    ).toBe("failed");
    expect(accounts.updateSyncState).not.toHaveBeenCalled();
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
          launchFileInjectedAccountIds: ["cacc_claude"],
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
        launchFileInjectedAccountIds: ["cacc_claude"],
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
        launchFileInjectedAccountIds: ["cacc_claude"],
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
        launchFileInjectedAccountIds: ["cacc_claude"],
        credentialCipher: fakeCipher,
        readCredentialsJson: () =>
          Effect.succeed(credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000)),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
      expect(accounts.updateSyncState).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect(
    "never touches an env-injected workspace: no exec, no repo reads (launch-shape gate)",
    () => {
      const accounts = connectedAccountRepoStub(createClaudeAccount());
      const readCredentialsJson = vi.fn(() =>
        Effect.succeed(credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000)),
      );

      return Effect.gen(function* () {
        // The blueprint carries a claude ref, but the account was ENV-injected at launch (e.g. a
        // setup-token workspace whose account was reconnected token→file mid-run). The container
        // file — possibly harness-fabricated — must never be read, let alone synced.
        yield* syncBackClaudeCredentials({
          blueprint: claudeBlueprint,
          launchFileInjectedAccountIds: [],
          credentialCipher: fakeCipher,
          readCredentialsJson,
        });

        expect(readCredentialsJson).not.toHaveBeenCalled();
        expect(accounts.getById).not.toHaveBeenCalled();
        expect(accounts.replacePayload).not.toHaveBeenCalled();
      }).pipe(Effect.provide(provideAccounts(accounts)));
    },
  );

  it.effect("only syncs the accounts that were file-injected at launch", () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount());
    const readCredentialsJson = vi.fn(() =>
      Effect.succeed(credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000)),
    );

    return Effect.gen(function* () {
      yield* syncBackClaudeCredentials({
        blueprint: claudeBlueprint,
        launchFileInjectedAccountIds: ["cacc_other"],
        credentialCipher: fakeCipher,
        readCredentialsJson,
      });

      expect(readCredentialsJson).not.toHaveBeenCalled();
      expect(accounts.replacePayload).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("rejects a sentinel expiresAt more than 30 days in the future", () => {
    const accounts = connectedAccountRepoStub(createClaudeAccount());

    return Effect.gen(function* () {
      // Strictly newer than the stored copy, so it would pass newest-wins — but implausibly far
      // in the future (a fabricated file), so the plausibility belt must reject it.
      yield* syncBackClaudeCredentials({
        blueprint: claudeBlueprint,
        launchFileInjectedAccountIds: ["cacc_claude"],
        credentialCipher: fakeCipher,
        readCredentialsJson: () => Effect.succeed(credentialsJsonWithExpiry(9_999_999_999_999)),
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
        launchFileInjectedAccountIds: ["cacc_claude"],
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
        launchFileInjectedAccountIds: ["cacc_claude"],
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
        launchFileInjectedAccountIds: ["cacc_claude"],
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
        launchFileInjectedAccountIds: ["cacc_claude"],
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
        launchFileInjectedAccountIds: ["cacc_claude"],
        credentialCipher: fakeCipher,
        readCredentialsJson: () =>
          Effect.succeed(credentialsJsonWithExpiry(STORED_EXPIRES_AT + 1_000)),
      });

      expect(accounts.updateSyncState).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });
});
