import { describe, expect, it } from "@effect/vitest";
import type { CredentialCipherService } from "@sealant/credentials";
import { CredentialCipherError } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  type ConnectedAccount,
  type ConnectedAccountRepoService,
} from "@sealant/db";
import { newWorkspaceSchema, type NewWorkspace } from "@sealant/validators";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import { resolveCredentialInjections } from "./connected-account-resolver.js";
import { WorkspaceBuildJobProcessingError } from "./errors.js";

/** Reversible fake cipher: "sealed:<plaintext>" — decrypt just strips the prefix. */
const fakeCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) =>
    sealed.startsWith("sealed:")
      ? Effect.succeed(sealed.slice("sealed:".length))
      : Effect.fail(new CredentialCipherError({ operation: "decrypt", message: "bad seal" })),
};

const createAccount = (overrides: Partial<ConnectedAccount> = {}): ConnectedAccount =>
  ({
    id: "cacc_1",
    ownerUserId: "usr_1",
    provider: "claude",
    name: "default",
    kind: "oauth-token",
    status: "active",
    encryptedPayload: `sealed:${JSON.stringify({ token: "sk-ant-oat01-test" })}`,
    encryptionKeyId: "k-test",
    payloadSha256: "abc",
    metadata: {},
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    lastUsedAt: null,
    lastSyncedAt: null,
    invalidAt: null,
    archivedAt: null,
    ...overrides,
  }) as ConnectedAccount;

const connectedAccountRepoStub = (accounts: readonly ConnectedAccount[]) => ({
  getById: vi.fn((id: string) => Effect.succeed(accounts.find((account) => account.id === id))),
  updateSyncState: vi.fn((_input: unknown) => Effect.succeed(accounts[0])),
});

const provideAccounts = (stub: unknown) =>
  Layer.succeed(ConnectedAccountRepo, stub as ConnectedAccountRepoService);

const createBlueprint = (credentialRefs: NewWorkspace["runtime"]["credentialRefs"]): NewWorkspace =>
  newWorkspaceSchema.parse({
    sources: { workspace: { url: "https://github.com/example/repo.git" } },
    harness: { id: "opencode" },
    runtime: { credentialRefs },
  });

describe("resolveCredentialInjections", () => {
  it.effect("returns an empty plan when the blueprint carries no credential refs", () => {
    const accounts = connectedAccountRepoStub([]);

    return Effect.gen(function* () {
      const resolved = yield* resolveCredentialInjections({
        blueprint: createBlueprint([]),
        // No cipher configured is fine when nothing needs decrypting.
        credentialCipher: undefined,
      });

      expect(resolved).toEqual({ injections: [], codexAccounts: [] });
      expect(accounts.getById).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect(
    "fails loudly when refs are present but SEALANT_CREDENTIALS_KEY is unconfigured",
    () => {
      const accounts = connectedAccountRepoStub([createAccount()]);

      return Effect.gen(function* () {
        const error = yield* resolveCredentialInjections({
          blueprint: createBlueprint([{ provider: "claude", ref: "connected-account:cacc_1" }]),
          credentialCipher: undefined,
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceBuildJobProcessingError);
        expect(error.errorCode).toBe("credentials-key-unconfigured");
        expect(error.message).toContain("SEALANT_CREDENTIALS_KEY");
        expect(accounts.getById).not.toHaveBeenCalled();
      }).pipe(Effect.provide(provideAccounts(accounts)));
    },
  );

  it.effect("fails naming provider and ref when the account does not exist", () => {
    const accounts = connectedAccountRepoStub([]);

    return Effect.gen(function* () {
      const error = yield* resolveCredentialInjections({
        blueprint: createBlueprint([{ provider: "claude", ref: "connected-account:cacc_missing" }]),
        credentialCipher: fakeCipher,
      }).pipe(Effect.flip);

      expect(error.errorCode).toBe("connected-account-unavailable");
      expect(error.message).toContain("connected-account:cacc_missing");
      expect(error.message).toContain("claude");
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("treats archived accounts as unavailable", () => {
    const accounts = connectedAccountRepoStub([
      createAccount({ status: "archived", archivedAt: new Date() }),
    ]);

    return Effect.gen(function* () {
      const error = yield* resolveCredentialInjections({
        blueprint: createBlueprint([{ provider: "claude", ref: "connected-account:cacc_1" }]),
        credentialCipher: fakeCipher,
      }).pipe(Effect.flip);

      expect(error.errorCode).toBe("connected-account-unavailable");
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("fails with a reconnect message when the account is marked invalid", () => {
    const accounts = connectedAccountRepoStub([
      createAccount({ status: "invalid", invalidAt: new Date() }),
    ]);

    return Effect.gen(function* () {
      const error = yield* resolveCredentialInjections({
        blueprint: createBlueprint([{ provider: "claude", ref: "connected-account:cacc_1" }]),
        credentialCipher: fakeCipher,
      }).pipe(Effect.flip);

      expect(error.errorCode).toBe("connected-account-invalid");
      expect(error.message).toContain("Reconnect");
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("fails when the ref is not a connected-account ref", () => {
    const accounts = connectedAccountRepoStub([createAccount()]);

    return Effect.gen(function* () {
      const error = yield* resolveCredentialInjections({
        blueprint: createBlueprint([{ provider: "claude", ref: "not-a-ref" }]),
        credentialCipher: fakeCipher,
      }).pipe(Effect.flip);

      expect(error.errorCode).toBe("connected-account-ref-invalid");
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("resolves env + file injections across providers and stamps last_used_at", () => {
    const codexAuthJson = JSON.stringify({
      tokens: { refresh_token: "rt-1" },
      last_refresh: "2026-07-01T00:00:00.000Z",
    });
    const accounts = connectedAccountRepoStub([
      createAccount(),
      createAccount({
        id: "cacc_codex",
        provider: "codex",
        kind: "auth-json",
        encryptedPayload: `sealed:${JSON.stringify({ authJson: codexAuthJson })}`,
        metadata: { lastRefresh: "2026-06-30T00:00:00.000Z" },
      }),
      createAccount({
        id: "cacc_github",
        provider: "github",
        kind: "gh-cli-token",
        encryptedPayload: `sealed:${JSON.stringify({ token: "gho_test" })}`,
      }),
    ]);

    return Effect.gen(function* () {
      const resolved = yield* resolveCredentialInjections({
        blueprint: createBlueprint([
          { provider: "claude", ref: "connected-account:cacc_1" },
          { provider: "codex", ref: "connected-account:cacc_codex" },
          { provider: "github", ref: "connected-account:cacc_github" },
        ]),
        credentialCipher: fakeCipher,
      });

      expect(resolved.injections).toEqual([
        { kind: "env", key: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-test" },
        {
          kind: "file",
          path: "$HOME/.codex/auth.json",
          contentBase64: Buffer.from(codexAuthJson, "utf8").toString("base64"),
          mode: "600",
        },
        { kind: "env", key: "GITHUB_TOKEN", value: "gho_test" },
        { kind: "env", key: "GH_TOKEN", value: "gho_test" },
      ]);
      expect(resolved.codexAccounts).toEqual([
        { connectedAccountId: "cacc_codex", storedLastRefresh: "2026-06-30T00:00:00.000Z" },
      ]);
      expect(accounts.updateSyncState).toHaveBeenCalledTimes(3);
      expect(accounts.updateSyncState).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cacc_1", lastUsedAt: expect.any(Date) }),
      );
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("does not fail the launch when the last_used_at bookkeeping write fails", () => {
    const accounts = {
      getById: vi.fn((_id: string) => Effect.succeed(createAccount())),
      updateSyncState: vi.fn((_input: unknown) => Effect.fail(new Error("db hiccup"))),
    };

    return Effect.gen(function* () {
      const resolved = yield* resolveCredentialInjections({
        blueprint: createBlueprint([{ provider: "claude", ref: "connected-account:cacc_1" }]),
        credentialCipher: fakeCipher,
      });

      expect(resolved.injections).toHaveLength(1);
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("fails when the decrypted payload is not the provider shape", () => {
    const accounts = connectedAccountRepoStub([
      createAccount({
        encryptedPayload: `sealed:${JSON.stringify({ token: "not-a-claude-token" })}`,
      }),
    ]);

    return Effect.gen(function* () {
      const error = yield* resolveCredentialInjections({
        blueprint: createBlueprint([{ provider: "claude", ref: "connected-account:cacc_1" }]),
        credentialCipher: fakeCipher,
      }).pipe(Effect.flip);

      expect(error.errorCode).toBe("connected-account-payload-invalid");
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });
});
