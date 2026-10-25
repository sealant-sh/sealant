/**
 * Routing tests for the inference module: provider resolution (explicit claude/codex, ambiguous
 * selections, profile-binding fallback), the codex arm's tool rejection and auth policy, and the
 * point-of-use auth.json persist hook — all against stub engines and repos. SEALANT_CREDENTIALS_KEY
 * is stubbed before the dynamic import because runtime-env parses process.env at module load.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  InferenceBadRequestError,
  InferenceConflictError,
  InferenceNotFoundError,
  type InferenceRespondRequest,
} from "@sealant/api-contracts";
import {
  CODEX_COPY_REFRESH_TOKEN,
  CredentialCipher,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  InferenceUsageRepo,
  ProfileRepo,
  type ConnectedAccount,
  type ConnectedAccountRepoService,
  type ProfileRepoService,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { InferenceEngineTurn, InferenceStartInput } from "./claude-engine.js";
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
    credentialRevision: 1,
    ...overrides,
  }) as ConnectedAccount;

const codexAccount = account({ provider: "codex", id: "cacc_codex" });
const claudeAccount = account({
  provider: "claude",
  id: "cacc_claude",
  kind: "credentials-json",
  encryptedPayload: `sealed:${JSON.stringify({ credentialsJson: claudeCredentialsJson })}`,
});

const codexKey = "sk-proj-FAKEcodexkeyforthetests0000wxyz";
const codexKeyAccount = account({
  provider: "codex",
  id: "cacc_codex_key",
  kind: "api-key",
  encryptedPayload: `sealed:${JSON.stringify({ apiKey: codexKey })}`,
  metadata: { tokenSuffix: "wxyz" },
});
const claudeKey = "sk-ant-api03-FAKEclaudekeyforthetests000000wxyz";
const claudeKeyAccount = account({
  provider: "claude",
  id: "cacc_claude_key",
  kind: "api-key",
  encryptedPayload: `sealed:${JSON.stringify({ apiKey: claudeKey })}`,
});

interface AccountsStubOptions {
  readonly byName?: Record<string, ConnectedAccount | undefined>;
  readonly defaults?: Record<string, ConnectedAccount | undefined>;
  readonly bindings?: readonly { binding: { provider: string }; account: ConnectedAccount }[];
}

const accountsStub = (options: AccountsStubOptions = {}) => ({
  getById: vi.fn((id: string) =>
    Effect.succeed(
      [codexAccount, claudeAccount, codexKeyAccount, claudeKeyAccount].find(
        (candidate) => candidate.id === id,
      ) ?? undefined,
    ),
  ),
  getByOwnerProviderName: vi.fn((input: { provider: string; name: string }) =>
    Effect.succeed(options.byName?.[`${input.provider}:${input.name}`]),
  ),
  getDefault: vi.fn((input: { provider: string }) =>
    Effect.succeed(options.defaults?.[input.provider]),
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
  const recorded: Array<{
    readonly ownerUserId: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }> = [];
  const claudeStart = vi.fn((_start: InferenceStartInput) =>
    Effect.succeed(doneTurn("claude answer")),
  );
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
    Layer.succeed(InferenceUsageRepo, {
      tokensOn: () => Effect.succeed(0),
      record: (usage) =>
        Effect.sync(() => {
          recorded.push(usage);
        }),
    }),
  );

  const engines: EngineStubs = { claudeStart, codexStart };
  return { layer, engines, recorded };
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

const continuation = (ownerUserId: string): InferenceRespondRequest => ({
  ownerUserId,
  sessionId: "inf_parked",
  toolResults: [{ toolCallId: "call_1", content: "ok" }],
});

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

  it("spends the chosen default for `default`, not the account named default", async () => {
    const chosen = { ...codexAccount, name: "work" };
    const named = account({ provider: "codex", id: "cacc_named_default" });
    const accounts = accountsStub({
      byName: { "codex:default": named },
      defaults: { codex: chosen },
    });
    const { layer } = makeLayers({ accounts });

    await run(
      respond(newExchange({ credentials: { codex: "default" } })).pipe(Effect.provide(layer)),
    );

    expect(accounts.updateSyncState).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cacc_codex" }),
    );
    expect(accounts.updateSyncState).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "cacc_named_default" }),
    );
  });

  it("refuses `default` while none is chosen, though an account is named default", async () => {
    const accounts = accountsStub({ byName: { "codex:default": codexAccount } });
    const { layer } = makeLayers({ accounts });

    const error = await runFlipped(
      respond(newExchange({ credentials: { codex: "default" } })).pipe(Effect.provide(layer)),
    );

    expect(error).toBeInstanceOf(InferenceNotFoundError);
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

  it("hands the CLI a copy that cannot refresh, and never writes a rotation back", async () => {
    const accounts = accountsStub();
    let seen: { refresh_token?: unknown } | undefined;
    let home = "";
    const { layer } = makeLayers({
      accounts,
      codexStart: async (startInput) => {
        home = startInput.codexHome;
        seen = (
          JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as { tokens?: typeof seen }
        ).tokens;
        // Even a CLI that rewrote the file (it cannot refresh a copy) is never read back.
        writeFileSync(
          join(home, "auth.json"),
          JSON.stringify({ tokens: { access_token: "at-2", refresh_token: "rt-2" } }),
        );
        await startInput.onSessionEnd?.();
        return doneTurn("ok");
      },
    });

    await run(respond(newExchange({})).pipe(Effect.provide(layer)));

    expect(seen?.refresh_token).toBe(CODEX_COPY_REFRESH_TOKEN);
    expect(accounts.replacePayload).not.toHaveBeenCalled();
    expect(existsSync(home)).toBe(false);
  });

  it("runs Codex on a key from Codex's own key file in its private home", async () => {
    const accounts = accountsStub();
    let seen: unknown;
    let home = "";
    const { layer } = makeLayers({
      accounts,
      codexStart: async (startInput) => {
        home = startInput.codexHome;
        seen = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
        await startInput.onSessionEnd?.();
        return doneTurn("ok");
      },
    });

    await run(
      respond(newExchange({ credentials: { codex: "cacc_codex_key" } })).pipe(
        Effect.provide(layer),
      ),
    );

    expect(seen).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: codexKey });
    expect(existsSync(home)).toBe(false);
  });

  it("runs Claude on a key from a private key file the engine reads, removed at the end", async () => {
    const accounts = accountsStub();
    const { layer, engines } = makeLayers({ accounts });

    const response = await run(
      respond(newExchange({ credentials: { claude: "cacc_claude_key" } })).pipe(
        Effect.provide(layer),
      ),
    );

    expect(response.turn).toEqual(expect.objectContaining({ text: "claude answer" }));
    const startInput = engines.claudeStart.mock.calls[0]?.[0] as InferenceStartInput;
    if (startInput.auth.kind !== "api-key") throw new Error("expected api-key auth");
    expect(statSync(startInput.auth.configDir).mode & 0o777).toBe(0o700);
    expect(statSync(startInput.auth.keyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(startInput.auth.keyPath, "utf8")).toBe(claudeKey);
    await startInput.onSessionEnd?.();
    expect(existsSync(startInput.auth.configDir)).toBe(false);
  });

  it("serves a parked exchange only to the owner who opened it", async () => {
    const accounts = accountsStub();
    const parked: InferenceEngineTurn = {
      sessionId: "inf_parked",
      turn: { type: "toolCalls", calls: [{ toolCallId: "call_1", name: "search", input: {} }] },
    };
    const continued = vi.fn(() => Effect.succeed(doneTurn("finished")));
    const { layer } = makeLayers({ accounts });
    const withParkedSession = Layer.mergeAll(
      layer,
      Layer.succeed(InferenceEngine, {
        start: vi.fn(() => Effect.succeed(parked)),
        continueSession: continued,
      }),
    );
    await run(
      respond(newExchange({ credentials: { claude: "cacc_claude" } })).pipe(
        Effect.provide(withParkedSession),
      ),
    );

    const foreign = await runFlipped(
      respond(continuation("usr_other")).pipe(Effect.provide(withParkedSession)),
    );
    expect(foreign).toBeInstanceOf(InferenceNotFoundError);
    // The engine was never asked: the refusal has no effect on the parked session.
    expect(continued).not.toHaveBeenCalled();

    await run(respond(continuation("usr_1")).pipe(Effect.provide(withParkedSession)));
    expect(continued).toHaveBeenCalledTimes(1);
  });

  it("records what an exchange spent against its owner", async () => {
    const { layer, recorded } = makeLayers({ accounts: accountsStub() });
    await run(respond(newExchange({})).pipe(Effect.provide(layer)));
    expect(recorded).toEqual([
      expect.objectContaining({ ownerUserId: "usr_1", inputTokens: 1, outputTokens: 1 }),
    ]);
  });
});

const setupTokenAccount = account({
  provider: "claude",
  id: "cacc_claude_token",
  kind: "token",
  encryptedPayload: `sealed:${JSON.stringify({ token: "sk-ant-oat01-FAKEsetuptokenforthetests0000" })}`,
});

const parkedTurn: InferenceEngineTurn = {
  sessionId: "inf_parked",
  turn: { type: "toolCalls", calls: [{ toolCallId: "call_1", name: "search", input: {} }] },
};

/** A Claude engine whose start parks on a tool call and whose continuation does `continued`. */
const parkingLayers = (
  accounts: ReturnType<typeof accountsStub>,
  continued: () => Effect.Effect<InferenceEngineTurn, InferenceEngineError>,
) => {
  const { layer } = makeLayers({ accounts });
  return Layer.mergeAll(
    layer,
    Layer.succeed(InferenceEngine, {
      start: vi.fn(() => Effect.succeed(parkedTurn)),
      continueSession: vi.fn(continued),
    }),
  );
};

describe("inference.module receipts", () => {
  it("answers with the receipt of the login it ran on", async () => {
    const { layer } = makeLayers({ accounts: accountsStub() });

    const subscription = await run(
      respond(newExchange({ credentials: { claude: "cacc_claude" } })).pipe(Effect.provide(layer)),
    );
    const key = await run(
      respond(newExchange({ credentials: { codex: "cacc_codex_key" } })).pipe(
        Effect.provide(layer),
      ),
    );

    expect(subscription.receipt).toEqual({
      accountId: "cacc_claude",
      revision: 1,
      login: "subscription",
    });
    expect(key.receipt).toEqual({ accountId: "cacc_codex_key", revision: 1, login: "api-key" });
  });

  it("carries the receipt on a failure after the account was resolved", async () => {
    const { layer } = makeLayers({
      accounts: accountsStub(),
      codexStart: () => Promise.reject(new InferenceEngineError("engine", "boom")),
    });

    const error = await runFlipped(respond(newExchange({})).pipe(Effect.provide(layer)));

    expect(error).toMatchObject({
      receipt: { accountId: "cacc_codex", revision: 1, login: "subscription" },
    });
  });

  it("continues on the start's receipt after a reconnect, without resolving again", async () => {
    let current = setupTokenAccount;
    const accounts = accountsStub();
    accounts.getById.mockImplementation(() => Effect.succeed(current));
    const layer = parkingLayers(accounts, () => Effect.succeed(doneTurn("finished")));

    const started = await run(
      respond(newExchange({ credentials: { claude: "cacc_claude_token" } })).pipe(
        Effect.provide(layer),
      ),
    );
    current = { ...setupTokenAccount, credentialRevision: 2 };
    const lookups = accounts.getById.mock.calls.length;
    const continued = await run(respond(continuation("usr_1")).pipe(Effect.provide(layer)));

    expect(started.receipt).toEqual({
      accountId: "cacc_claude_token",
      revision: 1,
      login: "subscription",
    });
    expect(continued.receipt).toEqual(started.receipt);
    expect(accounts.getById.mock.calls.length).toBe(lookups);
  });

  it("judges a continuation's auth failure by the start's receipt", async () => {
    const accounts = accountsStub();
    accounts.getById.mockImplementation(() => Effect.succeed(setupTokenAccount));
    const layer = parkingLayers(accounts, () =>
      Effect.fail(new InferenceEngineError("auth", "authentication_failed")),
    );

    await run(
      respond(newExchange({ credentials: { claude: "cacc_claude_token" } })).pipe(
        Effect.provide(layer),
      ),
    );
    const error = await runFlipped(respond(continuation("usr_1")).pipe(Effect.provide(layer)));

    expect(error).toBeInstanceOf(InferenceConflictError);
    expect(error).toMatchObject({ receipt: { accountId: "cacc_claude_token", revision: 1 } });
    expect(accounts.markInvalid).toHaveBeenCalledWith({ id: "cacc_claude_token", revision: 1 });
  });
});
