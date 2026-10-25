/**
 * Inference route handlers — inference on connected accounts, via the official agent SDKs.
 *
 * Flow (design doc §9): resolve the caller's account REFERENCE (same shape and ownership semantics
 * as workspace creation), decrypt the stored credential, hand it to the provider's engine —
 * {@link InferenceEngine} (the official Claude Agent SDK) for claude accounts,
 * {@link CodexInferenceEngine} (the official Codex CLI) for codex accounts — and stamp
 * `last_used_at`, the same per-account attribution workspace injection does.
 */
import {
  BudgetExceededError,
  InferenceBadRequestError,
  InferenceConflictError,
  InferenceInternalServerError,
  InferenceNotFoundError,
  InferenceUnavailableError,
  type InferenceReceipt,
  type InferenceRespondRequest,
  type InferenceRespondResponse,
  type InferenceTurn,
} from "@sealant/api-contracts";
import {
  claudeCredentialsCopy,
  codexLoginFile,
  CredentialCipher,
  extractClaudeOauthCredentials,
  extractCodexSecrets,
  parseClaudeCredentialPayload,
  parseCodexCredentialPayload,
  provisionClaudeConfigDir,
  provisionClaudeKeyDir,
  provisionCodexHome,
  removeClaudeConfigDir,
  removeCodexHome,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  InferenceUsageRepo,
  ProfileRepo,
  type ConnectedAccount,
} from "@sealant/db";
import { Effect } from "effect";

import { env } from "../../runtime-env.js";
import { budgetLimits } from "../../services/budget-limits.js";
import { budgetMessage, ceilingDecision, secondsUntilUtcMidnight } from "../../services/budgets.js";
import {
  lookupConnectedAccount,
  missingAccountMessage,
} from "../../services/connected-account-lookup.js";
import { redactProviderKeys } from "../../services/credential-redaction.js";
import { spendOwnerLaunch } from "../../services/owner-budgets.js";
import {
  InferenceEngine,
  InferenceEngineError,
  type InferenceEngineTurn,
} from "./claude-engine.js";
import { CodexInferenceEngine } from "./codex-engine.js";
import { redactSecrets, redactStrings } from "./support.js";

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const withInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) =>
  effect.pipe(
    Effect.mapError(
      (error) => new InferenceInternalServerError({ message: toErrorMessage(error, fallback) }),
    ),
  );

/** Same gate as connected-accounts: without the cipher key there are no credentials to resolve. */
const requireCredentialsKey = Effect.gen(function* () {
  const key = env.SEALANT_CREDENTIALS_KEY?.trim();
  if (key === undefined || key.length === 0) {
    return yield* new InferenceUnavailableError({
      message: "Inference on connected accounts requires SEALANT_CREDENTIALS_KEY to be configured.",
    });
  }
});

/**
 * Resolve the request's credential selection to a connected account, mirroring the
 * workspace-create semantics: explicit id/name wins over the profile binding; unknown, foreign,
 * wrong-provider, and archived accounts are a uniform 404; a non-active account is a 409
 * ("reconnect it"). Selecting both providers in one exchange is ambiguous (400). A profileId-only
 * selection prefers the profile's claude binding and falls back to its codex binding.
 */
const resolveAccount = (input: {
  readonly ownerUserId: string;
  readonly credentials: NonNullable<InferenceRespondRequest["credentials"]>;
}) =>
  Effect.gen(function* () {
    const credentials = input.credentials;
    if (credentials.claude !== undefined && credentials.codex !== undefined) {
      return yield* new InferenceBadRequestError({
        message:
          "Select one provider per exchange: set credentials.claude or credentials.codex, not both.",
      });
    }

    const resolveExplicit = (provider: "claude" | "codex", selection: string) =>
      Effect.gen(function* () {
        const lookup = yield* withInternalError(
          lookupConnectedAccount({ ownerUserId: input.ownerUserId, provider, selection }),
          "Failed to load connected account.",
        );
        if (lookup.kind === "missing") {
          return yield* new InferenceNotFoundError({
            message: missingAccountMessage(provider, selection),
          });
        }
        return lookup.account;
      });

    let account: ConnectedAccount | undefined;

    if (credentials.claude !== undefined) {
      account = yield* resolveExplicit("claude", credentials.claude);
    } else if (credentials.codex !== undefined) {
      account = yield* resolveExplicit("codex", credentials.codex);
    } else if (credentials.profileId !== undefined) {
      const accounts = yield* ConnectedAccountRepo;
      const profiles = yield* ProfileRepo;
      const profile = yield* withInternalError(
        profiles.getProfileById(credentials.profileId),
        "Failed to load profile.",
      );
      if (profile === undefined || profile.ownerUserId !== input.ownerUserId) {
        return yield* new InferenceNotFoundError({
          message: `Profile not found: ${credentials.profileId}`,
        });
      }
      const bindings = yield* withInternalError(
        accounts.getBindingsForProfileWithAccounts(profile.id),
        "Failed to load profile credential bindings.",
      );
      // Claude first (the richer inference surface — caller tools), codex as the fallback.
      const usable = (provider: "claude" | "codex") => {
        const bound = bindings.find(({ binding }) => binding.provider === provider)?.account;
        return bound !== undefined && bound.archivedAt === null ? bound : undefined;
      };
      account = usable("claude") ?? usable("codex");
      if (account === undefined) {
        return yield* new InferenceBadRequestError({
          message: `Profile ${credentials.profileId} has no usable claude or codex account binding.`,
        });
      }
    } else {
      return yield* new InferenceBadRequestError({
        message:
          "Inference requires a connected account: set credentials.claude or credentials.codex (id or name), or credentials.profileId with a claude or codex binding.",
      });
    }

    // Inference IS the credential use — a non-active account is a hard error either way.
    if (account.status !== "active") {
      return yield* new InferenceConflictError({
        message: `Connected ${account.provider} account "${account.name}" is invalid — reconnect it.`,
      });
    }
    return account;
  });

type ExchangeLogin =
  | { readonly shape: "claude-key"; readonly apiKey: string }
  | { readonly shape: "claude-setup-token"; readonly token: string }
  | {
      readonly shape: "claude-session";
      readonly credentialsJson: string;
      readonly accessToken: string;
      readonly refreshToken: string | undefined;
    }
  | { readonly shape: "codex-key"; readonly apiKey: string }
  | { readonly shape: "codex-chatgpt"; readonly authJson: string };

type LoginShape = ExchangeLogin["shape"];

interface Exchange {
  readonly ownerUserId: string;
  readonly receipt: InferenceReceipt;
  readonly login: ExchangeLogin;
}

const loginClassOfShape = (shape: LoginShape): InferenceReceipt["login"] =>
  shape === "claude-key" || shape === "codex-key" ? "api-key" : "subscription";

const secretsOf = (login: ExchangeLogin): readonly (string | undefined)[] => {
  switch (login.shape) {
    case "claude-key":
    case "codex-key": {
      return [login.apiKey];
    }
    case "claude-setup-token": {
      return [login.token];
    }
    case "claude-session": {
      return [login.accessToken, login.refreshToken];
    }
    case "codex-chatgpt": {
      return extractCodexSecrets(login.authJson);
    }
  }
};

const readLogin = (account: ConnectedAccount, payloadJson: string) =>
  Effect.try({
    try: (): ExchangeLogin => {
      const payload: unknown = JSON.parse(payloadJson);
      if (account.provider === "codex") {
        const codex = parseCodexCredentialPayload(payload);
        return "apiKey" in codex
          ? { shape: "codex-key", apiKey: codex.apiKey }
          : { shape: "codex-chatgpt", authJson: codex.authJson };
      }
      const claude = parseClaudeCredentialPayload(payload);
      if ("apiKey" in claude) {
        return { shape: "claude-key", apiKey: claude.apiKey };
      }
      if ("token" in claude) {
        return { shape: "claude-setup-token", token: claude.token };
      }
      const extracted = extractClaudeOauthCredentials(claude.credentialsJson);
      if (extracted === undefined) {
        throw new Error("credentials.json payload is unusable");
      }
      return { shape: "claude-session", credentialsJson: claude.credentialsJson, ...extracted };
    },
    catch: () =>
      new InferenceInternalServerError({
        message: `Stored ${account.provider} credential payload is malformed.`,
      }),
  });

const provisionError = (what: string) => (cause: unknown) =>
  new InferenceEngineError("engine", toErrorMessage(cause, `Failed to provision the ${what}.`));

const startEngine = (login: ExchangeLogin, payload: InferenceRespondRequest) =>
  Effect.gen(function* () {
    const common = {
      prompt: payload.prompt ?? "",
      ...(payload.system === undefined ? {} : { system: payload.system }),
      ...(payload.model === undefined ? {} : { model: payload.model }),
      ...(payload.responseFormat === undefined ? {} : { responseFormat: payload.responseFormat }),
    };

    if (login.shape === "codex-key" || login.shape === "codex-chatgpt") {
      const engine = yield* CodexInferenceEngine;
      const provisioned = yield* Effect.try({
        try: () =>
          provisionCodexHome({
            authJson: codexLoginFile(
              login.shape === "codex-key" ? { apiKey: login.apiKey } : { authJson: login.authJson },
            ),
          }),
        catch: provisionError("codex home dir"),
      });
      return yield* engine.start({
        ...common,
        codexHome: provisioned.codexHome,
        secrets: secretsOf(login).filter((secret) => secret !== undefined),
        onSessionEnd: () => Promise.resolve(removeCodexHome(provisioned.codexHome)),
      });
    }

    const engine = yield* InferenceEngine;
    const claudeCommon = {
      ...common,
      ...(payload.maxTurns === undefined ? {} : { maxTurns: payload.maxTurns }),
      tools: payload.tools ?? [],
    };
    switch (login.shape) {
      case "claude-setup-token": {
        return yield* engine.start({
          ...claudeCommon,
          auth: { kind: "oauth-token", oauthToken: login.token },
        });
      }
      case "claude-session": {
        const provisioned = yield* Effect.try({
          try: () =>
            provisionClaudeConfigDir({
              credentialsJson: claudeCredentialsCopy(login.credentialsJson),
            }),
          catch: provisionError("claude session config dir"),
        });
        return yield* engine.start({
          ...claudeCommon,
          auth: {
            kind: "config-dir",
            configDir: provisioned.configDir,
            accessToken: login.accessToken,
          },
          onSessionEnd: () => Promise.resolve(removeClaudeConfigDir(provisioned.configDir)),
        });
      }
      case "claude-key": {
        const provisioned = yield* Effect.try({
          try: () => provisionClaudeKeyDir({ apiKey: login.apiKey }),
          catch: provisionError("claude key dir"),
        });
        return yield* engine.start({
          ...claudeCommon,
          auth: {
            kind: "api-key",
            configDir: provisioned.configDir,
            keyPath: provisioned.keyPath,
            apiKey: login.apiKey,
          },
          onSessionEnd: () => Promise.resolve(removeClaudeConfigDir(provisioned.configDir)),
        });
      }
    }
  });

type AuthReason = "auth-401" | "auth-words";
type KeyLogin = Extract<ExchangeLogin, { readonly shape: "claude-key" | "codex-key" }>;

const marksInvalidOn: Record<LoginShape, readonly AuthReason[]> = {
  "claude-key": ["auth-401"],
  "codex-key": ["auth-401"],
  "claude-setup-token": ["auth-401", "auth-words"],
  "claude-session": [],
  "codex-chatgpt": [],
};

type Invalidation = "marked" | "superseded" | "unmarked";

const invalidate = (exchange: Exchange, reason: AuthReason) =>
  marksInvalidOn[exchange.login.shape].includes(reason)
    ? Effect.flatMap(ConnectedAccountRepo, (accounts) =>
        accounts
          .markInvalid({ id: exchange.receipt.accountId, revision: exchange.receipt.revision })
          .pipe(
            Effect.map((marked): Invalidation => (marked === undefined ? "superseded" : "marked")),
            Effect.orElseSucceed((): Invalidation => "unmarked"),
          ),
      )
    : Effect.succeed<Invalidation>("unmarked");

const keyRefusal = (login: KeyLogin, invalidation: Invalidation) => {
  const provider = login.shape === "claude-key" ? "Anthropic" : "OpenAI";
  const key = `Your ${login.shape === "claude-key" ? "Claude" : "Codex"} API key ····${login.apiKey.slice(-4)}`;
  switch (invalidation) {
    case "marked": {
      return {
        message: `${key} was refused by ${provider}. It is marked invalid; connect a new key.`,
        code: "connected-account-refused",
      } as const;
    }
    case "superseded": {
      return {
        message: `${key} was refused by ${provider}. The account changed after this exchange started, so it is not marked invalid.`,
        code: "connected-account-superseded",
      } as const;
    }
    case "unmarked": {
      return {
        message: `${key} was not accepted by ${provider}. It is not marked invalid; if the key was revoked, connect a new one.`,
      } as const;
    }
  }
};

const authFailure = (exchange: Exchange, reason: AuthReason, detail: string) =>
  Effect.gen(function* () {
    const invalidation = yield* invalidate(exchange, reason);
    const { login, receipt } = exchange;
    switch (login.shape) {
      case "claude-key":
      case "codex-key": {
        return new InferenceConflictError({ ...keyRefusal(login, invalidation), receipt });
      }
      case "claude-session": {
        return new InferenceConflictError({
          message:
            "The Claude login did not authenticate. The platform refreshes it on a schedule, so this usually means the login itself was ended (signed out elsewhere, or revoked) — reconnect Claude.",
          receipt,
        });
      }
      case "codex-chatgpt": {
        return new InferenceConflictError({
          message:
            "The Codex login did not authenticate. The platform refreshes it on a schedule, so this usually means the login itself was ended (signed out elsewhere, or revoked) — reconnect Codex.",
          receipt,
        });
      }
      case "claude-setup-token": {
        return new InferenceConflictError({
          message: `The connected account was rejected by the provider — reconnect it. (${detail})`,
          receipt,
        });
      }
    }
  });

const EXCHANGES_MAX = 10_000;
const parkedExchanges = new Map<string, Exchange>();

const parkExchange = (sessionId: string, exchange: Exchange): void => {
  if (!parkedExchanges.has(sessionId) && parkedExchanges.size >= EXCHANGES_MAX) {
    const oldest = parkedExchanges.keys().next();
    if (oldest.done !== true) parkedExchanges.delete(oldest.value);
  }
  parkedExchanges.set(sessionId, exchange);
};

const redacting =
  (exchange: Exchange) =>
  (text: string): string =>
    redactProviderKeys(redactSecrets(text, secretsOf(exchange.login)));

const answerTurn = (
  exchange: Exchange,
  engineTurn: InferenceEngineTurn,
): InferenceRespondResponse => {
  if (engineTurn.turn.type === "toolCalls") {
    parkExchange(engineTurn.sessionId, exchange);
  } else {
    parkedExchanges.delete(engineTurn.sessionId);
  }
  const redact = redacting(exchange);
  const turn: InferenceTurn =
    engineTurn.turn.type === "done"
      ? {
          type: "text",
          text: redact(engineTurn.turn.text),
          ...(engineTurn.turn.json === undefined
            ? {}
            : { json: redactStrings(engineTurn.turn.json, redact) }),
        }
      : {
          type: "toolCalls",
          calls: engineTurn.turn.calls.map((call) => ({
            ...call,
            input: redactStrings(call.input, redact),
          })),
        };
  return {
    sessionId: engineTurn.sessionId,
    turn,
    ...(engineTurn.turn.type === "done" && engineTurn.turn.usage !== undefined
      ? { usage: engineTurn.turn.usage }
      : {}),
    receipt: exchange.receipt,
  };
};

const failTurn = (exchange: Exchange, sessionId: string | undefined, raw: InferenceEngineError) =>
  Effect.gen(function* () {
    if (sessionId !== undefined) parkedExchanges.delete(sessionId);
    const { receipt } = exchange;
    const message = redacting(exchange)(raw.message);
    switch (raw.reason) {
      case "session-not-found": {
        return yield* new InferenceNotFoundError({ message, receipt });
      }
      case "bad-tool-result": {
        return yield* new InferenceBadRequestError({ message, receipt });
      }
      case "timeout":
      case "engine": {
        return yield* new InferenceInternalServerError({ message, receipt });
      }
      case "auth-401":
      case "auth-words": {
        const refusal = yield* authFailure(exchange, raw.reason, message);
        return yield* refusal;
      }
    }
  });

const settleTurn = <R>(
  exchange: Exchange,
  sessionId: string | undefined,
  turn: Effect.Effect<InferenceEngineTurn, InferenceEngineError, R>,
) =>
  turn.pipe(
    Effect.catch((error) => failTurn(exchange, sessionId, error)),
    Effect.map((engineTurn) => answerTurn(exchange, engineTurn)),
  );

const continueExchange = (
  payload: InferenceRespondRequest & { readonly sessionId: string },
  toolResults: NonNullable<InferenceRespondRequest["toolResults"]>,
) =>
  Effect.gen(function* () {
    const exchange = parkedExchanges.get(payload.sessionId);
    // Another owner's session answers exactly like one that does not exist.
    if (exchange === undefined || exchange.ownerUserId !== payload.ownerUserId) {
      return yield* new InferenceNotFoundError({
        message: `Inference session not found (or expired): ${payload.sessionId}. Start the exchange over.`,
      });
    }
    const engine = yield* InferenceEngine;
    return yield* settleTurn(
      exchange,
      payload.sessionId,
      engine.continueSession({ sessionId: payload.sessionId, toolResults }),
    );
  });

const startExchange = (payload: InferenceRespondRequest) =>
  Effect.gen(function* () {
    yield* requireCredentialsKey;
    if (payload.credentials === undefined) {
      return yield* new InferenceBadRequestError({
        message: "A new exchange requires credentials (a claude connected-account reference).",
      });
    }

    const account = yield* resolveAccount({
      ownerUserId: payload.ownerUserId,
      credentials: payload.credentials,
    });

    const cipher = yield* CredentialCipher;
    const accounts = yield* ConnectedAccountRepo;
    const payloadJson = yield* withInternalError(
      cipher.decrypt(account.encryptedPayload),
      "Failed to decrypt the connected account credential.",
    );
    const login = yield* readLogin(account, payloadJson);
    const exchange: Exchange = {
      ownerUserId: payload.ownerUserId,
      receipt: {
        accountId: account.id,
        revision: account.credentialRevision,
        login: loginClassOfShape(login.shape),
      },
      login,
    };

    if (payload.allowedLogin === "subscription" && exchange.receipt.login === "api-key") {
      return yield* new InferenceConflictError({
        message: `Connected ${account.provider} account "${account.name}" holds an API key, and this request allows only a subscription. Nothing was sent to ${account.provider === "claude" ? "Anthropic" : "OpenAI"}.`,
        code: "login-not-allowed",
        receipt: exchange.receipt,
      });
    }

    if (account.provider === "codex" && (payload.tools ?? []).length > 0) {
      return yield* new InferenceBadRequestError({
        message:
          "Codex inference does not support caller-defined tools yet — run tool exchanges on a claude connected account.",
        receipt: exchange.receipt,
      });
    }

    // Attribute the use exactly like workspace injection does — best-effort, never fails the call.
    yield* accounts.updateSyncState({ id: account.id, lastUsedAt: new Date() }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Failed to stamp last_used_at for connected account ${account.id}; continuing.`,
          cause,
        ),
      ),
      Effect.asVoid,
    );

    return yield* settleTurn(exchange, undefined, startEngine(login, payload));
  });

const respondUnmetered = (payload: InferenceRespondRequest) =>
  Effect.gen(function* () {
    const isNew = payload.prompt !== undefined;
    const isContinuation = payload.sessionId !== undefined || payload.toolResults !== undefined;
    if (isNew === isContinuation) {
      return yield* new InferenceBadRequestError({
        message:
          "Send either a new exchange (credentials + prompt) or a continuation (sessionId + toolResults), not both or neither.",
      });
    }
    if (!isContinuation) {
      return yield* startExchange(payload);
    }
    const { sessionId, toolResults } = payload;
    if (sessionId === undefined || toolResults === undefined) {
      return yield* new InferenceBadRequestError({
        message: "A continuation requires both sessionId and toolResults.",
      });
    }
    return yield* continueExchange({ ...payload, sessionId }, toolResults);
  });

const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * `respond`, inside the owner's budgets (CORE-04). A new exchange needs room in the owner's daily
 * token budget and spends one launch; a continuation belongs to an exchange already admitted, so
 * it is never refused half-way. Usage is recorded when a turn reports it. Recording is
 * best-effort: a failed write is logged and the answer the owner paid for is still returned, so
 * the budget can under-count after a database fault and never over-refuses because of one.
 */
export const respond = (payload: InferenceRespondRequest) =>
  Effect.gen(function* () {
    const usage = yield* InferenceUsageRepo;
    const now = new Date();
    // Only a well-formed new exchange is metered: a malformed request spends nothing.
    const opensExchange =
      payload.prompt !== undefined &&
      payload.sessionId === undefined &&
      payload.toolResults === undefined;
    if (opensExchange) {
      const limit = budgetLimits.ownerInferenceTokensPerDay;
      if (limit > 0) {
        const spent = yield* usage
          .tokensOn(payload.ownerUserId, utcDay(now))
          .pipe(
            Effect.mapError(
              () =>
                new InferenceInternalServerError({ message: "Failed to read inference usage." }),
            ),
          );
        const decision = ceilingDecision(
          "ownerInferenceTokensPerDay",
          spent,
          limit,
          secondsUntilUtcMidnight(now),
        );
        if (!decision.allowed) {
          return yield* new BudgetExceededError({
            message: budgetMessage(decision),
            budget: decision.budget,
            limit: decision.limit,
            retryAfterSeconds: decision.retryAfterSeconds,
          });
        }
      }
      yield* spendOwnerLaunch(payload.ownerUserId);
    }

    const response = yield* respondUnmetered(payload);

    if (response.usage !== undefined) {
      yield* usage
        .record({
          ownerUserId: payload.ownerUserId,
          day: utcDay(new Date()),
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Failed to record inference usage; the daily budget under-counts.",
              cause,
            ),
          ),
        );
    }
    return response;
  });
