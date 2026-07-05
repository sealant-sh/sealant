import { describe, expect, it } from "@effect/vitest";
import type { CredentialCipherService } from "@sealant/credentials";
import { sha256Hex } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  type ConnectedAccount,
  type ConnectedAccountRepoService,
} from "@sealant/db";
import { newSandboxSchema, type NewSandbox } from "@sealant/validators";
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import { isNewerCodexAuthRefresh, syncBackCodexAuthJson } from "./codex-auth-sync-back.js";

const fakeCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

const createCodexAccount = (overrides: Partial<ConnectedAccount> = {}): ConnectedAccount =>
  ({
    id: "cacc_codex",
    ownerUserId: "usr_1",
    provider: "codex",
    name: "default",
    kind: "auth-json",
    status: "active",
    encryptedPayload: "sealed:old",
    encryptionKeyId: "k-test",
    payloadSha256: "old-sha",
    metadata: { lastRefresh: "2026-07-01T00:00:00.000Z", authMode: "chatgpt" },
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

const codexBlueprint: NewSandbox = newSandboxSchema.parse({
  sources: { sandbox: { url: "https://github.com/example/repo.git" } },
  harness: { id: "opencode" },
  runtime: { credentialRefs: [{ provider: "codex", ref: "connected-account:cacc_codex" }] },
});

const noCodexBlueprint: NewSandbox = newSandboxSchema.parse({
  sources: { sandbox: { url: "https://github.com/example/repo.git" } },
  harness: { id: "opencode" },
});

const authJsonWithRefresh = (lastRefresh: string): string =>
  JSON.stringify({ tokens: { refresh_token: "rt-rotated" }, last_refresh: lastRefresh });

describe("isNewerCodexAuthRefresh", () => {
  it("never persists when the observed auth.json has no last_refresh", () => {
    expect(
      isNewerCodexAuthRefresh({ observedLastRefresh: undefined, storedLastRefresh: undefined }),
    ).toBe(false);
    expect(
      isNewerCodexAuthRefresh({
        observedLastRefresh: undefined,
        storedLastRefresh: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("persists a first-ever refresh timestamp", () => {
    expect(
      isNewerCodexAuthRefresh({
        observedLastRefresh: "2026-07-01T00:00:00.000Z",
        storedLastRefresh: undefined,
      }),
    ).toBe(true);
  });

  it("persists only strictly newer refreshes (rotated-refresh-token safety)", () => {
    const stored = "2026-07-01T00:00:00.000Z";
    expect(
      isNewerCodexAuthRefresh({
        observedLastRefresh: "2026-07-02T00:00:00.000Z",
        storedLastRefresh: stored,
      }),
    ).toBe(true);
    // Equal must NOT write.
    expect(
      isNewerCodexAuthRefresh({ observedLastRefresh: stored, storedLastRefresh: stored }),
    ).toBe(false);
    // Older must NOT write.
    expect(
      isNewerCodexAuthRefresh({
        observedLastRefresh: "2026-06-30T00:00:00.000Z",
        storedLastRefresh: stored,
      }),
    ).toBe(false);
  });

  it("keeps the stored copy when the observed timestamp is unparseable", () => {
    expect(
      isNewerCodexAuthRefresh({
        observedLastRefresh: "not-a-date",
        storedLastRefresh: "2026-07-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("prefers a valid observed timestamp over an unparseable stored one", () => {
    expect(
      isNewerCodexAuthRefresh({
        observedLastRefresh: "2026-07-01T00:00:00.000Z",
        storedLastRefresh: "garbage",
      }),
    ).toBe(true);
  });
});

describe("syncBackCodexAuthJson", () => {
  it.effect("persists a strictly newer auth.json with merged metadata and sync bookkeeping", () => {
    const accounts = connectedAccountRepoStub(createCodexAccount());
    const rotated = authJsonWithRefresh("2026-07-04T12:00:00.000Z");

    return Effect.gen(function* () {
      yield* syncBackCodexAuthJson({
        blueprint: codexBlueprint,
        credentialCipher: fakeCipher,
        readAuthJson: () => Effect.succeed(rotated),
      });

      const expectedPlaintext = JSON.stringify({ authJson: rotated });
      expect(accounts.replacePayload).toHaveBeenCalledWith({
        id: "cacc_codex",
        encryptedPayload: `sealed:${expectedPlaintext}`,
        encryptionKeyId: "k-test",
        payloadSha256: sha256Hex(expectedPlaintext),
        metadata: expect.objectContaining({
          lastRefresh: "2026-07-04T12:00:00.000Z",
          // Pre-existing metadata untouched by the parse survives the merge.
          authMode: "chatgpt",
        }),
      });
      expect(accounts.updateSyncState).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cacc_codex", lastSyncedAt: expect.any(Date) }),
      );
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("never writes when the observed refresh is equal to the stored one", () => {
    const accounts = connectedAccountRepoStub(createCodexAccount());

    return Effect.gen(function* () {
      yield* syncBackCodexAuthJson({
        blueprint: codexBlueprint,
        credentialCipher: fakeCipher,
        readAuthJson: () => Effect.succeed(authJsonWithRefresh("2026-07-01T00:00:00.000Z")),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
      expect(accounts.updateSyncState).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("never writes when the observed refresh is older than the stored one", () => {
    const accounts = connectedAccountRepoStub(createCodexAccount());

    return Effect.gen(function* () {
      yield* syncBackCodexAuthJson({
        blueprint: codexBlueprint,
        credentialCipher: fakeCipher,
        readAuthJson: () => Effect.succeed(authJsonWithRefresh("2026-06-01T00:00:00.000Z")),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("skips (with a warning, not a failure) when auth.json cannot be read", () => {
    const accounts = connectedAccountRepoStub(createCodexAccount());

    return Effect.gen(function* () {
      yield* syncBackCodexAuthJson({
        blueprint: codexBlueprint,
        credentialCipher: fakeCipher,
        readAuthJson: () => Effect.fail(new Error("container is gone")),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("skips when the observed auth.json is invalid", () => {
    const accounts = connectedAccountRepoStub(createCodexAccount());

    return Effect.gen(function* () {
      yield* syncBackCodexAuthJson({
        blueprint: codexBlueprint,
        credentialCipher: fakeCipher,
        readAuthJson: () => Effect.succeed("{ this is not json"),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("no-ops without touching the repo when the blueprint has no codex ref", () => {
    const accounts = connectedAccountRepoStub(createCodexAccount());
    const readAuthJson = vi.fn(() =>
      Effect.succeed(authJsonWithRefresh("2026-07-04T00:00:00.000Z")),
    );

    return Effect.gen(function* () {
      yield* syncBackCodexAuthJson({
        blueprint: noCodexBlueprint,
        credentialCipher: fakeCipher,
        readAuthJson,
      });

      expect(readAuthJson).not.toHaveBeenCalled();
      expect(accounts.getById).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("skips when the connected account has been archived since launch", () => {
    const accounts = connectedAccountRepoStub(createCodexAccount({ archivedAt: new Date() }));

    return Effect.gen(function* () {
      yield* syncBackCodexAuthJson({
        blueprint: codexBlueprint,
        credentialCipher: fakeCipher,
        readAuthJson: () => Effect.succeed(authJsonWithRefresh("2026-07-04T00:00:00.000Z")),
      });

      expect(accounts.replacePayload).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });

  it.effect("degrades to a warning when the repo write fails", () => {
    const accounts = {
      getById: vi.fn((_id: string) => Effect.succeed(createCodexAccount())),
      replacePayload: vi.fn((_input: unknown) => Effect.fail(new Error("db down"))),
      updateSyncState: vi.fn((_input: unknown) => Effect.succeed(undefined)),
    };

    return Effect.gen(function* () {
      // Must not fail even though replacePayload does.
      yield* syncBackCodexAuthJson({
        blueprint: codexBlueprint,
        credentialCipher: fakeCipher,
        readAuthJson: () => Effect.succeed(authJsonWithRefresh("2026-07-04T00:00:00.000Z")),
      });

      expect(accounts.updateSyncState).not.toHaveBeenCalled();
    }).pipe(Effect.provide(provideAccounts(accounts)));
  });
});
