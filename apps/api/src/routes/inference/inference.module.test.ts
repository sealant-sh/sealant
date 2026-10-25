/**
 * Routing tests for the inference module: provider resolution (explicit claude/codex, ambiguous
 * selections, profile-binding fallback), the codex arm's tool rejection and auth policy, and the
 * point-of-use auth.json persist hook — all against stub engines and repos. SEALANT_CREDENTIALS_KEY
 * is stubbed before the dynamic import because runtime-env parses process.env at module load.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  CredentialCipherError,
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
import { Effect, Fiber, Layer } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  InferenceEngineService,
  InferenceEngineTurn,
  InferenceStartInput,
} from "./claude-engine.js";
import { claudeEngineLayer, InferenceEngine, InferenceEngineError } from "./claude-engine.js";
import { CodexInferenceEngine, type CodexInferenceStartInput } from "./codex-engine.js";
import type { Exchange } from "./exchange.js";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.fixture.js";

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
  markInvalid: vi.fn((_input: { id: string; revision?: number }) =>
    Effect.succeed<ConnectedAccount | undefined>({ ...codexAccount, status: "invalid" }),
  ),
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

const endingWith = (turn: InferenceEngineTurn) =>
  vi.fn((start: InferenceStartInput) =>
    Effect.promise(async () => {
      await start.onSessionEnd?.();
      return turn;
    }),
  );

const makeLayers = (input: {
  readonly accounts: ReturnType<typeof accountsStub>;
  readonly codexStart?: (start: CodexInferenceStartInput) => Promise<InferenceEngineTurn>;
}) => {
  const recorded: Array<{
    readonly ownerUserId: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  }> = [];
  const claudeStart = endingWith(doneTurn("claude answer"));
  const codexStart = vi.fn((startInput: CodexInferenceStartInput) =>
    (input.codexStart === undefined
      ? Effect.succeed(doneTurn("codex answer"))
      : Effect.tryPromise({
          try: () => input.codexStart!(startInput),
          catch: (error) =>
            error instanceof InferenceEngineError
              ? error
              : new InferenceEngineError("engine", String(error)),
        })
    ).pipe(Effect.ensuring(Effect.promise(async () => startInput.onSessionEnd?.()))),
  );

  const layer = Layer.mergeAll(
    Layer.succeed(ConnectedAccountRepo, input.accounts as unknown as ConnectedAccountRepoService),
    Layer.succeed(ProfileRepo, profilesStub() as unknown as ProfileRepoService),
    Layer.succeed(CredentialCipher, fakeCipher),
    Layer.succeed(
      InferenceEngine,
      stubEngine({
        start: claudeStart,
        continueSession: vi.fn(() =>
          Effect.fail(new InferenceEngineError("session-not-found", "no session")),
        ),
      }),
    ),
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

/** An engine stub that, like the live engine, holds each started exchange under its session. */
const stubEngine = (
  engine: Pick<InferenceEngineService, "start" | "continueSession">,
): InferenceEngineService => {
  const exchanges = new Map<string, Exchange>();
  return {
    exchange: (sessionId) => exchanges.get(sessionId),
    start: (input) =>
      engine
        .start(input)
        .pipe(
          Effect.tap((turn) => Effect.sync(() => exchanges.set(turn.sessionId, input.exchange))),
        ),
    continueSession: engine.continueSession,
  };
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
      codexStart: () => Promise.reject(new InferenceEngineError("auth-401", "401 Unauthorized")),
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

  it("removes the private dir of a start interrupted before the engine answers", async () => {
    const started: string[] = [];
    const { layer } = makeLayers({ accounts: accountsStub() });
    const stalled = Layer.mergeAll(
      layer,
      Layer.succeed(
        InferenceEngine,
        stubEngine({
          start: (start) =>
            Effect.sync(() => started.push(start.auth.configDir)).pipe(
              Effect.andThen(Effect.never),
            ),
          continueSession: () => Effect.fail(new InferenceEngineError("session-not-found", "")),
        }),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          respond(newExchange({ credentials: { claude: "cacc_claude_key" } })).pipe(
            Effect.provide(stalled),
          ),
        );
        while (started.length === 0) yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(started).toHaveLength(1);
    expect(existsSync(started[0] ?? "")).toBe(false);
  });

  it("runs Claude on a key from a private key file the engine reads, removed at the end", async () => {
    let seen:
      | { readonly dirMode: number; readonly fileMode: number; readonly key: string }
      | undefined;
    let configDir = "";
    const { layer } = makeLayers({ accounts: accountsStub() });
    const reading = Layer.mergeAll(
      layer,
      Layer.succeed(
        InferenceEngine,
        stubEngine({
          start: (start) =>
            Effect.promise(async () => {
              if (start.auth.kind !== "api-key") throw new Error("expected api-key auth");
              configDir = start.auth.configDir;
              seen = {
                dirMode: statSync(start.auth.configDir).mode & 0o777,
                fileMode: statSync(start.auth.keyPath).mode & 0o777,
                key: readFileSync(start.auth.keyPath, "utf8"),
              };
              await start.onSessionEnd?.();
              return doneTurn("claude answer");
            }),
          continueSession: () => Effect.fail(new InferenceEngineError("session-not-found", "none")),
        }),
      ),
    );

    const response = await run(
      respond(newExchange({ credentials: { claude: "cacc_claude_key" } })).pipe(
        Effect.provide(reading),
      ),
    );

    expect(response.turn).toEqual(expect.objectContaining({ text: "claude answer" }));
    expect(seen).toEqual({ dirMode: 0o700, fileMode: 0o600, key: claudeKey });
    expect(existsSync(configDir)).toBe(false);
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
      Layer.succeed(
        InferenceEngine,
        stubEngine({ start: endingWith(parked), continueSession: continued }),
      ),
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

const setupToken = "sk-ant-oat01-FAKEsetuptokenforthetests0000";
const setupTokenAccount = account({
  provider: "claude",
  id: "cacc_claude_token",
  kind: "token",
  encryptedPayload: `sealed:${JSON.stringify({ token: setupToken })}`,
});

const parkedTurn: InferenceEngineTurn = {
  sessionId: "inf_parked",
  turn: { type: "toolCalls", calls: [{ toolCallId: "call_1", name: "search", input: {} }] },
};

const parkingLayers = (
  accounts: ReturnType<typeof accountsStub>,
  continued: () => Effect.Effect<InferenceEngineTurn, InferenceEngineError>,
) => {
  const { layer } = makeLayers({ accounts });
  return Layer.mergeAll(
    layer,
    Layer.succeed(
      InferenceEngine,
      stubEngine({ start: endingWith(parkedTurn), continueSession: vi.fn(continued) }),
    ),
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

  it("carries the receipt on every failure before the engine starts", async () => {
    const unusableGrant = account({
      provider: "claude",
      id: "cacc_claude_unusable",
      kind: "credentials-json",
      encryptedPayload: `sealed:${JSON.stringify({ credentialsJson: "{}" })}`,
    });
    const malformed = account({ id: "cacc_codex_malformed", encryptedPayload: "sealed:{" });
    const invalid = { ...claudeKeyAccount, status: "invalid" as const };
    const accounts = accountsStub({
      byName: {
        "claude:unusable": unusableGrant,
        "codex:malformed": malformed,
        "claude:invalid": invalid,
      },
    });
    const { layer } = makeLayers({ accounts });
    const undecryptable = Layer.mergeAll(
      layer,
      Layer.succeed(CredentialCipher, {
        ...fakeCipher,
        decrypt: () =>
          Effect.fail(new CredentialCipherError({ operation: "decrypt", message: "bad key" })),
      }),
    );
    const failure = (credentials: InferenceRespondRequest["credentials"]) =>
      runFlipped(respond(newExchange({ credentials })).pipe(Effect.provide(layer)));

    expect(await failure({ claude: "unusable" })).toMatchObject({
      receipt: { accountId: "cacc_claude_unusable", revision: 1, login: "subscription" },
    });
    expect(await failure({ codex: "malformed" })).toMatchObject({
      receipt: { accountId: "cacc_codex_malformed", revision: 1, login: "subscription" },
    });
    expect(await failure({ claude: "invalid" })).toMatchObject({
      message: expect.stringContaining("reconnect it"),
      receipt: { accountId: "cacc_claude_key", revision: 1, login: "api-key" },
    });
    expect(
      await runFlipped(
        respond(newExchange({ credentials: { codex: "cacc_codex_key" } })).pipe(
          Effect.provide(undecryptable),
        ),
      ),
    ).toMatchObject({
      receipt: { accountId: "cacc_codex_key", revision: 1, login: "api-key" },
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
      Effect.fail(new InferenceEngineError("auth-401", "authentication_failed")),
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

const guardMarkInvalid = (
  accounts: ReturnType<typeof accountsStub>,
  current: () => ConnectedAccount,
) => {
  accounts.getById.mockImplementation(() => Effect.succeed(current()));
  accounts.markInvalid.mockImplementation((input: { id: string; revision?: number }) =>
    Effect.succeed(
      input.revision === current().credentialRevision
        ? { ...current(), status: "invalid" as const }
        : undefined,
    ),
  );
};

describe("inference.module redaction", () => {
  const leak = "token at-codex beside sk-proj-FAKEsomeoneelseskey00000000";

  it("redacts the login's secrets and provider keys from an answer", async () => {
    const { layer } = makeLayers({
      accounts: accountsStub(),
      codexStart: () =>
        Promise.resolve({
          sessionId: "inf_stub",
          turn: { type: "done", text: leak, json: { nested: [leak] } },
        }),
    });

    const response = await run(respond(newExchange({})).pipe(Effect.provide(layer)));

    const text = JSON.stringify(response.turn);
    expect(text).not.toContain("at-codex");
    expect(text).not.toContain("sk-proj-FAKE");
  });

  it("redacts them from an engine's error", async () => {
    const { layer } = makeLayers({
      accounts: accountsStub(),
      codexStart: () => Promise.reject(new InferenceEngineError("engine", leak)),
    });

    const error = await runFlipped(respond(newExchange({})).pipe(Effect.provide(layer)));

    expect(error).toMatchObject({ message: expect.stringContaining("token [redacted] beside") });
    expect(JSON.stringify(error)).not.toContain("sk-proj-FAKE");
  });

  it("redacts them from property names and tool names too", async () => {
    const answered = makeLayers({
      accounts: accountsStub(),
      codexStart: () =>
        Promise.resolve({
          sessionId: "inf_stub",
          turn: { type: "done", text: "ok", json: { "at-codex": [{ "at-codex": "at-codex" }] } },
        }),
    });
    const parked = Layer.mergeAll(
      makeLayers({ accounts: accountsStub() }).layer,
      Layer.succeed(
        InferenceEngine,
        stubEngine({
          start: endingWith({
            sessionId: "inf_parked",
            turn: {
              type: "toolCalls",
              calls: [{ toolCallId: "call_1", name: "at-claude", input: { "at-claude": 1 } }],
            },
          }),
          continueSession: () => Effect.fail(new InferenceEngineError("session-not-found", "")),
        }),
      ),
    );

    const done = await run(respond(newExchange({})).pipe(Effect.provide(answered.layer)));
    const calls = await run(
      respond(newExchange({ credentials: { claude: "cacc_claude" } })).pipe(Effect.provide(parked)),
    );

    expect(JSON.stringify(done)).not.toContain("at-codex");
    expect(JSON.stringify(calls)).not.toContain("at-claude");
  });

  it("redacts a key-shaped name or selection from every refusal", async () => {
    const keyName = "sk-ant-api03-FAKEanaccountnamedafterakey000";
    const named = { ...claudeKeyAccount, name: keyName };
    const accounts = accountsStub({
      byName: {
        [`claude:${keyName}`]: named,
        "claude:invalid": { ...named, status: "invalid" },
      },
    });
    const { layer } = makeLayers({ accounts });
    const refusal = (overrides: Partial<InferenceRespondRequest>) =>
      runFlipped(respond(newExchange(overrides)).pipe(Effect.provide(layer)));

    const refusals = [
      await refusal({ credentials: { claude: keyName }, allowedLogin: "subscription" }),
      await refusal({ credentials: { claude: "invalid" } }),
      await refusal({ credentials: { codex: "sk-proj-FAKEaselectionthatisakey000000" } }),
    ];

    expect(refusals.map((error) => JSON.stringify(error))).toEqual([
      expect.stringContaining("login-not-allowed"),
      expect.stringContaining("reconnect it"),
      expect.stringContaining("InferenceNotFoundError"),
    ]);
    for (const error of refusals) {
      expect(JSON.stringify(error)).not.toMatch(/sk-(ant|proj)-/);
    }
  });
});

describe("inference.module allowedLogin", () => {
  it("runs a subscription when the request allows only a subscription", async () => {
    const { layer, engines } = makeLayers({ accounts: accountsStub() });

    const response = await run(
      respond(newExchange({ allowedLogin: "subscription" })).pipe(Effect.provide(layer)),
    );

    expect(response.receipt).toMatchObject({ login: "subscription" });
    expect(engines.codexStart).toHaveBeenCalledOnce();
  });

  it("checks the account the selection resolved to, not the name it was asked by", async () => {
    const accounts = accountsStub({ defaults: { codex: codexKeyAccount } });
    const { layer, engines } = makeLayers({ accounts });

    const error = await runFlipped(
      respond(
        newExchange({ credentials: { codex: "default" }, allowedLogin: "subscription" }),
      ).pipe(Effect.provide(layer)),
    );

    expect(error).toMatchObject({
      code: "login-not-allowed",
      message:
        'Connected codex account "default" holds an API key, and this request allows only a subscription. Nothing was sent to OpenAI.',
    });
    expect(engines.codexStart).not.toHaveBeenCalled();
  });

  it("refuses a Codex auth.json that Codex would spend a key from", async () => {
    const ambiguous = account({
      provider: "codex",
      id: "cacc_codex_ambiguous",
      encryptedPayload: `sealed:${JSON.stringify({
        authJson: JSON.stringify({
          OPENAI_API_KEY: "sk-proj-FAKEkeybesidearefreshtoken00000000",
          tokens: { access_token: "at-codex", refresh_token: "rt-codex", id_token: "idt-codex" },
        }),
      })}`,
    });
    const { layer, engines } = makeLayers({
      accounts: accountsStub({ defaults: { codex: ambiguous } }),
    });

    const error = await runFlipped(
      respond(
        newExchange({ credentials: { codex: "default" }, allowedLogin: "subscription" }),
      ).pipe(Effect.provide(layer)),
    );

    expect(error).toMatchObject({
      code: "login-not-allowed",
      receipt: { accountId: "cacc_codex_ambiguous", login: "api-key" },
    });
    expect(engines.codexStart).not.toHaveBeenCalled();
  });
});

describe("inference.module 401 feedback", () => {
  it("marks a Codex key invalid on a structured 401, at the receipt's revision", async () => {
    const accounts = accountsStub();
    const { layer } = makeLayers({
      accounts,
      codexStart: () => Promise.reject(new InferenceEngineError("auth-401", "401")),
    });

    const error = await runFlipped(
      respond(newExchange({ credentials: { codex: "cacc_codex_key" } })).pipe(
        Effect.provide(layer),
      ),
    );

    expect(error).toMatchObject({
      code: "connected-account-refused",
      message:
        "Your Codex API key ····wxyz was refused by OpenAI. It is marked invalid; connect a new key.",
    });
    expect(accounts.markInvalid).toHaveBeenCalledWith({ id: "cacc_codex_key", revision: 1 });
  });

  it("never marks a key on words that only look like a 401", async () => {
    const accounts = accountsStub();
    const { layer } = makeLayers({
      accounts,
      codexStart: () => Promise.reject(new InferenceEngineError("auth-words", "401 Unauthorized")),
    });
    const claudeLayer = Layer.mergeAll(
      layer,
      Layer.succeed(
        InferenceEngine,
        stubEngine({
          start: (start) =>
            Effect.promise(async () => start.onSessionEnd?.()).pipe(
              Effect.andThen(
                Effect.fail(new InferenceEngineError("auth-words", "Invalid API key")),
              ),
            ),
          continueSession: () => Effect.fail(new InferenceEngineError("session-not-found", "none")),
        }),
      ),
    );

    const codex = await runFlipped(
      respond(newExchange({ credentials: { codex: "cacc_codex_key" } })).pipe(
        Effect.provide(layer),
      ),
    );
    const claude = await runFlipped(
      respond(newExchange({ credentials: { claude: "cacc_claude_key" } })).pipe(
        Effect.provide(claudeLayer),
      ),
    );

    expect(accounts.markInvalid).not.toHaveBeenCalled();
    expect(codex).not.toHaveProperty("code");
    expect(claude).not.toHaveProperty("code");
    expect(claude).toMatchObject({
      message:
        "Your Claude API key ····wxyz was not accepted by Anthropic. It is not marked invalid; if the key was revoked, connect a new one.",
    });
  });
});

describe("inference.module on a Claude key, against the real CLI", () => {
  let fake: FakeAnthropic;
  const realEngine = Effect.runSync(Effect.provide(InferenceEngine, claudeEngineLayer()));
  const configDirs: string[] = [];
  const engineLayer = Layer.succeed(InferenceEngine, {
    exchange: realEngine.exchange,
    start: (start) => {
      configDirs.push(start.auth.configDir);
      return realEngine.start(start);
    },
    continueSession: realEngine.continueSession,
  });

  beforeEach(async () => {
    fake = await startFakeAnthropic();
    process.env["ANTHROPIC_BASE_URL"] = fake.baseUrl;
    process.env["DISABLE_AUTOUPDATER"] = "1";
    process.env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
  });

  afterEach(async () => {
    await expect
      .poll(() => configDirs.filter((dir) => existsSync(dir)), { timeout: 10_000 })
      .toEqual([]);
    await fake.close();
  });

  const withRealEngine = (accounts: ReturnType<typeof accountsStub>) =>
    Layer.mergeAll(makeLayers({ accounts }).layer, engineLayer);

  const keyExchange = newExchange({
    credentials: { claude: "cacc_claude_key" },
    tools: [{ name: "search", inputSchema: { type: "object" } }],
  });

  it("marks the key invalid on Anthropic's 401", async () => {
    const accounts = accountsStub();
    guardMarkInvalid(accounts, () => claudeKeyAccount);
    fake.reply({ type: "status", status: 401, errorType: "authentication_error" });

    const error = await runFlipped(
      respond(keyExchange).pipe(Effect.provide(withRealEngine(accounts))),
    );

    expect(new Set(fake.apiKeys)).toEqual(new Set([claudeKey]));
    expect(error).toMatchObject({
      code: "connected-account-refused",
      message:
        "Your Claude API key ····wxyz was refused by Anthropic. It is marked invalid; connect a new key.",
      receipt: { accountId: "cacc_claude_key", revision: 1, login: "api-key" },
    });
    expect(accounts.markInvalid).toHaveBeenCalledWith({ id: "cacc_claude_key", revision: 1 });
  }, 60_000);

  it("never sends the host's own Claude login when a setup token is refused", async () => {
    const hostToken = "sk-ant-oat01-FAKEtheapihostsownloginmustnotbeused000000host";
    const home = mkdtempSync(join(tmpdir(), "inference-host-home-"));
    mkdirSync(join(home, ".claude"), { mode: 0o700 });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: hostToken,
          refreshToken: "sk-ant-ort01-FAKEhostrefresh",
          expiresAt: Date.now() + 365 * 24 * 3_600_000,
          scopes: ["user:inference", "user:profile"],
          subscriptionType: "max",
        },
      }),
      { mode: 0o600 },
    );
    const accounts = accountsStub();
    guardMarkInvalid(accounts, () => setupTokenAccount);
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;
    fake.reply(
      ...Array.from({ length: 20 }, () => ({
        type: "status" as const,
        status: 401,
        errorType: "authentication_error",
      })),
    );

    try {
      await runFlipped(
        respond(newExchange({ credentials: { claude: "cacc_claude_token" } })).pipe(
          Effect.provide(withRealEngine(accounts)),
        ),
      );
      await expect
        .poll(() => configDirs.filter((dir) => existsSync(dir)), { timeout: 10_000 })
        .toEqual([]);
    } finally {
      process.env["HOME"] = previousHome;
      rmSync(home, { recursive: true, force: true });
    }

    expect(fake.authorizations).toContain(`Bearer ${setupToken}`);
    const sent = [...fake.apiKeys, ...fake.authorizations].join("\n");
    expect(sent).not.toContain(hostToken);
  }, 60_000);

  it("refuses a key before any request when the request allows only a subscription", async () => {
    const accounts = accountsStub();

    const error = await runFlipped(
      respond({ ...keyExchange, allowedLogin: "subscription" }).pipe(
        Effect.provide(withRealEngine(accounts)),
      ),
    );

    expect(error).toBeInstanceOf(InferenceConflictError);
    expect(error).toMatchObject({
      code: "login-not-allowed",
      receipt: { accountId: "cacc_claude_key", login: "api-key" },
    });
    expect(fake.apiKeys).toEqual([]);
    expect(accounts.updateSyncState).not.toHaveBeenCalled();
  });

  it("does not mark the key on a refusal whose words say 401 but whose status does not", async () => {
    const accounts = accountsStub();
    guardMarkInvalid(accounts, () => claudeKeyAccount);
    fake.reply({
      type: "status",
      status: 400,
      errorType: "invalid_request_error",
      message: "401 Unauthorized: invalid x-api-key",
    });

    const error = await runFlipped(
      respond(keyExchange).pipe(Effect.provide(withRealEngine(accounts))),
    );

    expect(error).toMatchObject({
      message: expect.stringContaining("was not accepted by Anthropic. It is not marked invalid"),
    });
    expect(error).not.toHaveProperty("code");
    expect(accounts.markInvalid).not.toHaveBeenCalled();
  }, 60_000);

  it("marks the start's account on a 401 after a tool round", async () => {
    const accounts = accountsStub();
    guardMarkInvalid(accounts, () => claudeKeyAccount);
    fake.reply(
      { type: "toolUse", name: "mcp__caller__search", input: {} },
      { type: "status", status: 401, errorType: "authentication_error" },
    );
    const layer = withRealEngine(accounts);

    const parked = await run(respond(keyExchange).pipe(Effect.provide(layer)));
    if (parked.turn.type !== "toolCalls") throw new Error("expected a tool round");
    const toolCallId = parked.turn.calls[0]?.toolCallId ?? "";
    const error = await runFlipped(
      respond({
        ownerUserId: "usr_1",
        sessionId: parked.sessionId,
        toolResults: [{ toolCallId, content: "found" }],
      }).pipe(Effect.provide(layer)),
    );

    expect(error).toMatchObject({ code: "connected-account-refused" });
    expect(accounts.markInvalid).toHaveBeenCalledWith({ id: "cacc_claude_key", revision: 1 });
  }, 60_000);

  it("keeps the exchange through a batch with a bad id, so a corrected one finishes it", async () => {
    const accounts = accountsStub();
    fake.reply(
      { type: "toolUse", name: "mcp__caller__search", input: {} },
      { type: "text", text: "found it" },
    );
    const layer = withRealEngine(accounts);

    const parked = await run(respond(keyExchange).pipe(Effect.provide(layer)));
    if (parked.turn.type !== "toolCalls") throw new Error("expected a tool round");
    const toolCallId = parked.turn.calls[0]?.toolCallId ?? "";
    const results = (ids: readonly string[]) =>
      respond({
        ownerUserId: "usr_1",
        sessionId: parked.sessionId,
        toolResults: ids.map((id) => ({ toolCallId: id, content: "found" })),
      }).pipe(Effect.provide(layer));

    const refused = await runFlipped(results([toolCallId, "tc_bogus"]));
    const finished = await run(results([toolCallId]));

    expect(refused).toBeInstanceOf(InferenceBadRequestError);
    expect(refused).toMatchObject({ receipt: { accountId: "cacc_claude_key" } });
    expect(finished.turn).toMatchObject({ type: "text", text: "found it" });
  }, 60_000);

  it("answers superseded to a late 401 from a key replaced since the exchange started", async () => {
    let current = claudeKeyAccount;
    const accounts = accountsStub();
    guardMarkInvalid(accounts, () => current);
    fake.reply(
      { type: "toolUse", name: "mcp__caller__search", input: {} },
      { type: "status", status: 401, errorType: "authentication_error" },
    );
    const layer = withRealEngine(accounts);

    const parked = await run(respond(keyExchange).pipe(Effect.provide(layer)));
    if (parked.turn.type !== "toolCalls") throw new Error("expected a tool round");
    current = { ...claudeKeyAccount, credentialRevision: 2 };
    const error = await runFlipped(
      respond({
        ownerUserId: "usr_1",
        sessionId: parked.sessionId,
        toolResults: [{ toolCallId: parked.turn.calls[0]?.toolCallId ?? "", content: "found" }],
      }).pipe(Effect.provide(layer)),
    );

    expect(error).toMatchObject({
      code: "connected-account-superseded",
      receipt: { accountId: "cacc_claude_key", revision: 1 },
    });
    expect(accounts.markInvalid).toHaveBeenCalledWith({ id: "cacc_claude_key", revision: 1 });
  }, 60_000);
});
