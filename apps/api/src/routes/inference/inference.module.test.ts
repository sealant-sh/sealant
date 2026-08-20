/**
 * Routing tests for the inference module: provider resolution (explicit claude/codex, ambiguous
 * selections, profile-binding fallback), the codex arm's tool rejection and auth policy, and the
 * point-of-use auth.json persist hook — all against stub engines and repos. SEALANT_CREDENTIALS_KEY
 * is stubbed before the dynamic import because runtime-env parses process.env at module load.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  InferenceBadRequestError,
  InferenceConflictError,
  InferenceNotFoundError,
  type InferenceRespondRequest,
} from "@sealant/api-contracts";
import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ProfileRepo,
  type ConnectedAccount,
  type ConnectedAccountRepoService,
  type ProfileRepoService,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { InferenceEngineTurn } from "./claude-engine.js";
import { InferenceEngine, InferenceEngineError } from "./claude-engine.js";
import { CodexInferenceEngine, type CodexInferenceStartInput } from "./codex-engine.js";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");

let respond: (typeof import("./inference.module.js"))["respond"];

beforeAll(async () => {
  ({ respond } = await import("./inference.module.js"));
});

const fakeCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

const codexAuthJson = JSON.stringify({
  tokens: { access_token: "at-codex", refresh_token: "rt-codex", id_token: "idt-codex" },
  last_refresh: "2026-07-01T00:00:00.000Z",
  auth_mode: "chatgpt",
});

const claudeCredentialsJson = JSON.stringify({
  claudeAiOauth: { accessToken: "at-claude", refreshToken: "rt-claude", expiresAt: 1_750_000_000 },
});

const account = (overrides: Partial<ConnectedAccount>): ConnectedAccount =>
  ({
    id: "cacc_test",
    ownerUserId: "usr_1",
    provider: "codex",
    name: "default",
    kind: "auth-json",
    status: "active",
    encryptedPayload: `sealed:${JSON.stringify({ authJson: codexAuthJson })}`,
    encryptionKeyId: "k-test",
    payloadSha256: "sha",
    metadata: { lastRefresh: "2026-07-01T00:00:00.000Z" },
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    lastUsedAt: null,
    lastSyncedAt: null,
    invalidAt: null,
    archivedAt: null,
    ...overrides,
  }) as ConnectedAccount;

const codexAccount = account({ provider: "codex", id: "cacc_codex" });
const claudeAccount = account({
  provider: "claude",
  id: "cacc_claude",
  kind: "credentials-json",
  encryptedPayload: `sealed:${JSON.stringify({ credentialsJson: claudeCredentialsJson })}`,
});

interface AccountsStubOptions {
  readonly byName?: Record<string, ConnectedAccount | undefined>;
  readonly bindings?: readonly { binding: { provider: string }; account: ConnectedAccount }[];
}

const accountsStub = (options: AccountsStubOptions = {}) => ({
  getById: vi.fn((id: string) =>
    Effect.succeed(
      [codexAccount, claudeAccount].find((candidate) => candidate.id === id) ?? undefined,
    ),
  ),
  getByOwnerProviderName: vi.fn((input: { provider: string; name: string }) =>
    Effect.succeed(options.byName?.[`${input.provider}:${input.name}`]),
  ),
  getBindingsForProfileWithAccounts: vi.fn(() => Effect.succeed(options.bindings ?? [])),
  updateSyncState: vi.fn(() => Effect.succeed(undefined)),
  markInvalid: vi.fn(() => Effect.succeed(undefined)),
  replacePayload: vi.fn(() => Effect.succeed(undefined)),
});

const profilesStub = () => ({
  getProfileById: vi.fn((id: string) =>
    Effect.succeed(id === "prof_1" ? { id: "prof_1", ownerUserId: "usr_1" } : undefined),
  ),
});

interface EngineStubs {
  readonly claudeStart: ReturnType<typeof vi.fn>;
  readonly codexStart: ReturnType<typeof vi.fn>;
}

const doneTurn = (text: string): InferenceEngineTurn => ({
  sessionId: "inf_stub",
  turn: { type: "done", text, usage: { inputTokens: 1, outputTokens: 1 } },
});

const makeLayers = (input: {
  readonly accounts: ReturnType<typeof accountsStub>;
  readonly codexStart?: (start: CodexInferenceStartInput) => Promise<InferenceEngineTurn>;
}) => {
  const claudeStart = vi.fn(() => Effect.succeed(doneTurn("claude answer")));
  const codexStart = vi.fn((startInput: CodexInferenceStartInput) =>
    input.codexStart === undefined
      ? Effect.succeed(doneTurn("codex answer"))
      : Effect.tryPromise({
          try: () => input.codexStart!(startInput),
          catch: (error) =>
            error instanceof InferenceEngineError
              ? error
              : new InferenceEngineError("engine", String(error)),
        }),
  );

  const layer = Layer.mergeAll(
    Layer.succeed(ConnectedAccountRepo, input.accounts as unknown as ConnectedAccountRepoService),
    Layer.succeed(ProfileRepo, profilesStub() as unknown as ProfileRepoService),
    Layer.succeed(CredentialCipher, fakeCipher),
    Layer.succeed(InferenceEngine, {
      start: claudeStart,
      continueSession: vi.fn(() =>
        Effect.fail(new InferenceEngineError("session-not-found", "no session")),
      ),
    }),
    Layer.succeed(CodexInferenceEngine, { start: codexStart }),
  );

  const engines: EngineStubs = { claudeStart, codexStart };
  return { layer, engines };
};

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

const runFlipped = async (effect: Effect.Effect<unknown, unknown, never>): Promise<unknown> =>
  run(Effect.flip(effect));

const newExchange = (overrides: Partial<InferenceRespondRequest>): InferenceRespondRequest =>
  ({
    ownerUserId: "usr_1",
    prompt: "name this session",
    credentials: { codex: "cacc_codex" },
    ...overrides,
  }) as InferenceRespondRequest;

describe("inference.module provider routing", () => {
  it("routes a codex account to the codex engine with model passthrough", async () => {
    const accounts = accountsStub();
    const { layer, engines } = makeLayers({ accounts });

    const response = await run(
      respond(newExchange({ model: "lunna", system: "sys" })).pipe(Effect.provide(layer)),
    );

    expect(response.turn).toEqual(expect.objectContaining({ type: "text", text: "codex answer" }));
    expect(engines.claudeStart).not.toHaveBeenCalled();
    expect(engines.codexStart).toHaveBeenCalledOnce();
    const startInput = engines.codexStart.mock.calls[0]?.[0] as CodexInferenceStartInput;
    expect(startInput.model).toBe("lunna");
    expect(startInput.system).toBe("sys");
    expect(startInput.prompt).toBe("name this session");
    // Every token-like value from auth.json rides along for redaction.
    expect(startInput.secrets).toEqual(["at-codex", "rt-codex", "idt-codex"]);
    // The use was attributed exactly like workspace injection.
    expect(accounts.updateSyncState).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cacc_codex", lastUsedAt: expect.any(Date) }),
    );
  });

  it("still routes claude accounts to the claude engine", async () => {
    const accounts = accountsStub();
    const { layer, engines } = makeLayers({ accounts });

    const response = await run(
      respond(newExchange({ credentials: { claude: "cacc_claude" } })).pipe(Effect.provide(layer)),
    );

    expect(response.turn).toEqual(expect.objectContaining({ text: "claude answer" }));
    expect(engines.codexStart).not.toHaveBeenCalled();
  });

  it("rejects selecting both providers in one exchange", async () => {
    const accounts = accountsStub();
    const { layer } = makeLayers({ accounts });

    const error = await runFlipped(
      respond(newExchange({ credentials: { claude: "a", codex: "b" } })).pipe(
        Effect.provide(layer),
      ),
    );

    expect(error).toBeInstanceOf(InferenceBadRequestError);
    expect(error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("not both") }),
    );
  });

  it("rejects caller-defined tools on the codex arm (tool-less v1)", async () => {
    const accounts = accountsStub();
    const { layer, engines } = makeLayers({ accounts });

    const error = await runFlipped(
      respond(newExchange({ tools: [{ name: "search", inputSchema: { type: "object" } }] })).pipe(
        Effect.provide(layer),
      ),
    );

    expect(error).toBeInstanceOf(InferenceBadRequestError);
    expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining("tools") }));
    expect(engines.codexStart).not.toHaveBeenCalled();
  });

  it("maps a codex auth failure to a 409 reconnect WITHOUT marking the account invalid", async () => {
    const accounts = accountsStub();
    const { layer } = makeLayers({
      accounts,
      codexStart: () => Promise.reject(new InferenceEngineError("auth", "401 Unauthorized")),
    });

    const error = await runFlipped(respond(newExchange({})).pipe(Effect.provide(layer)));

    expect(error).toBeInstanceOf(InferenceConflictError);
    expect(error).toEqual(
      expect.objectContaining({ message: expect.stringContaining("reconnect") }),
    );
    // auth.json self-refreshes; marking invalid would block workspace launches needlessly.
    expect(accounts.markInvalid).not.toHaveBeenCalled();
  });

  it("resolves an unknown explicit codex name to a uniform 404", async () => {
    const accounts = accountsStub({ byName: {} });
    const { layer } = makeLayers({ accounts });

    const error = await runFlipped(
      respond(newExchange({ credentials: { codex: "missing" } })).pipe(Effect.provide(layer)),
    );

    expect(error).toBeInstanceOf(InferenceNotFoundError);
    expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining("codex") }));
  });

  it("prefers the profile's claude binding and falls back to codex", async () => {
    const withBoth = accountsStub({
      bindings: [
        { binding: { provider: "codex" }, account: codexAccount },
        { binding: { provider: "claude" }, account: claudeAccount },
      ],
    });
    const both = makeLayers({ accounts: withBoth });
    await run(
      respond(newExchange({ credentials: { profileId: "prof_1" } })).pipe(
        Effect.provide(both.layer),
      ),
    );
    expect(both.engines.claudeStart).toHaveBeenCalledOnce();
    expect(both.engines.codexStart).not.toHaveBeenCalled();

    const codexOnly = accountsStub({
      bindings: [{ binding: { provider: "codex" }, account: codexAccount }],
    });
    const fallback = makeLayers({ accounts: codexOnly });
    await run(
      respond(newExchange({ credentials: { profileId: "prof_1" } })).pipe(
        Effect.provide(fallback.layer),
      ),
    );
    expect(fallback.engines.codexStart).toHaveBeenCalledOnce();
  });

  it("persists a rotated auth.json through the end-of-session hook, newest-wins", async () => {
    const accounts = accountsStub();
    const rotated = JSON.stringify({
      tokens: { access_token: "at-2", refresh_token: "rt-2" },
      last_refresh: "2026-07-02T00:00:00.000Z",
    });
    const { layer } = makeLayers({
      accounts,
      codexStart: async (startInput) => {
        // The official CLI rotates auth.json in the provisioned home; simulate, then end.
        writeFileSync(join(startInput.codexHome, "auth.json"), rotated);
        await startInput.onSessionEnd?.();
        return doneTurn("ok");
      },
    });

    await run(respond(newExchange({})).pipe(Effect.provide(layer)));

    const expectedPlaintext = JSON.stringify({ authJson: rotated });
    expect(accounts.replacePayload).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cacc_codex",
        encryptedPayload: `sealed:${expectedPlaintext}`,
        metadata: expect.objectContaining({ lastRefresh: "2026-07-02T00:00:00.000Z" }),
      }),
    );
  });
});
