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
  loginClassOf,
  loginClassOfKind,
  parseConnectedAccountKind,
  parseStoredCredential,
  type ProviderCredentialPayload,
  provisionClaudeConfigDir,
  provisionClaudeKeyDir,
  provisionClaudeTokenDir,
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
import { Effect, Exit } from "effect";

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
import { openExchange, type Exchange, type ExchangeLogin } from "./exchange.js";
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
 * wrong-provider, and archived accounts are a uniform 404. Selecting both providers in one exchange
 * is ambiguous (400). A profileId-only selection prefers the profile's claude binding and falls
 * back to its codex binding.
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
    return account;
  });

const receiptField = (receipt: InferenceReceipt | undefined) =>
  receipt === undefined ? {} : { receipt };

/** What the account's stored kind says it spends, for an answer before its credential is read. */
const kindReceipt = (account: ConnectedAccount): InferenceReceipt | undefined => {
  const kind = parseConnectedAccountKind(account.kind);
  const login = kind === undefined ? undefined : loginClassOfKind(kind);
  return login === undefined
    ? undefined
    : { accountId: account.id, revision: account.credentialRevision, login };
};

type LoginShape = ExchangeLogin["shape"];

const exchangeLoginOf = (...credential: ProviderCredentialPayload): ExchangeLogin => {
  const [provider, payload] = credential;
  switch (provider) {
    case "codex": {
      return "apiKey" in payload
        ? { shape: "codex-key", apiKey: payload.apiKey }
        : { shape: "codex-auth-json", authJson: payload.authJson };
    }
    case "claude": {
      if ("apiKey" in payload) return { shape: "claude-key", apiKey: payload.apiKey };
      if ("token" in payload) return { shape: "claude-setup-token", token: payload.token };
      const extracted = extractClaudeOauthCredentials(payload.credentialsJson);
      if (extracted === undefined) throw new Error("credentials.json payload is unusable");
      return { shape: "claude-session", credentialsJson: payload.credentialsJson, ...extracted };
    }
    case "github": {
      throw new Error("a GitHub login runs no inference");
    }
  }
};

/** The login to run on, and what it spends as `loginClassOf` reads it: the one authority. */
const readLogin = (
  account: ConnectedAccount,
  payloadJson: string,
  receipt: InferenceReceipt | undefined,
) =>
  Effect.try({
    try: () => {
      const credential = parseStoredCredential(account.provider, payloadJson);
      const loginClass = loginClassOf(...credential);
      if (loginClass === undefined) throw new Error("a GitHub login runs no inference");
      return { login: exchangeLoginOf(...credential), loginClass };
    },
    catch: () =>
      new InferenceInternalServerError({
        message: `Stored ${account.provider} credential payload is malformed.`,
        ...receiptField(receipt),
      }),
  });

/**
 * `start` on a private dir it provisions. The engine removes the dir when its session ends; a
 * start interrupted before the engine answers removes it here too, so no window leaves it behind.
 */
const onPrivateDir = <D, A, E, R>(
  what: string,
  provision: () => D,
  remove: (dir: D) => void,
  start: (dir: D, onSessionEnd: () => Promise<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: provision,
      catch: (cause) =>
        new InferenceEngineError(
          "engine",
          toErrorMessage(cause, `Failed to provision the ${what}.`),
        ),
    }),
    (dir) => start(dir, () => Promise.resolve(remove(dir))),
    (dir, exit) => (Exit.hasInterrupts(exit) ? Effect.sync(() => remove(dir)) : Effect.void),
  );

const startEngine = (exchange: Exchange, payload: InferenceRespondRequest) =>
  Effect.gen(function* () {
    const { login } = exchange;
    const common = {
      prompt: payload.prompt ?? "",
      ...(payload.system === undefined ? {} : { system: payload.system }),
      ...(payload.model === undefined ? {} : { model: payload.model }),
      ...(payload.responseFormat === undefined ? {} : { responseFormat: payload.responseFormat }),
    };

    if (login.shape === "codex-key" || login.shape === "codex-auth-json") {
      const engine = yield* CodexInferenceEngine;
      return yield* onPrivateDir(
        "codex home dir",
        () =>
          provisionCodexHome({
            authJson: codexLoginFile(
              login.shape === "codex-key" ? { apiKey: login.apiKey } : { authJson: login.authJson },
            ),
          }).codexHome,
        removeCodexHome,
        (codexHome, onSessionEnd) =>
          engine.start({ ...common, codexHome, secrets: exchange.secrets, onSessionEnd }),
      );
    }

    const engine = yield* InferenceEngine;
    const claudeCommon = {
      ...common,
      exchange,
      ...(payload.maxTurns === undefined ? {} : { maxTurns: payload.maxTurns }),
      tools: payload.tools ?? [],
    };
    switch (login.shape) {
      case "claude-setup-token": {
        return yield* onPrivateDir(
          "claude token config dir",
          () => provisionClaudeTokenDir(),
          removeClaudeConfigDir,
          (configDir, onSessionEnd) =>
            engine.start({
              ...claudeCommon,
              auth: { kind: "oauth-token", configDir, oauthToken: login.token },
              onSessionEnd,
            }),
        );
      }
      case "claude-session": {
        return yield* onPrivateDir(
          "claude session config dir",
          () =>
            provisionClaudeConfigDir({
              credentialsJson: claudeCredentialsCopy(login.credentialsJson),
            }).configDir,
          removeClaudeConfigDir,
          (configDir, onSessionEnd) =>
            engine.start({
              ...claudeCommon,
              auth: { kind: "config-dir", configDir },
              onSessionEnd,
            }),
        );
      }
      case "claude-key": {
        return yield* onPrivateDir(
          "claude key dir",
          () => provisionClaudeKeyDir({ apiKey: login.apiKey }),
          ({ configDir }) => removeClaudeConfigDir(configDir),
          ({ configDir, keyPath }, onSessionEnd) =>
            engine.start({
              ...claudeCommon,
              auth: { kind: "api-key", configDir, keyPath },
              onSessionEnd,
            }),
        );
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
  "codex-auth-json": [],
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
      case "codex-auth-json": {
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

const redacting =
  (exchange: Exchange) =>
  (text: string): string =>
    redactProviderKeys(redactSecrets(text, exchange.secrets));

type RespondFailure =
  | BudgetExceededError
  | InferenceBadRequestError
  | InferenceNotFoundError
  | InferenceConflictError
  | InferenceUnavailableError
  | InferenceInternalServerError;

const redactFailure =
  (redact: (text: string) => string) =>
  (failure: RespondFailure): RespondFailure => {
    const message = redact(failure.message);
    if (failure instanceof InferenceConflictError) {
      return new InferenceConflictError({
        message,
        ...receiptField(failure.receipt),
        ...(failure.code === undefined ? {} : { code: failure.code }),
      });
    }
    if (failure instanceof InferenceBadRequestError) {
      return new InferenceBadRequestError({ message, ...receiptField(failure.receipt) });
    }
    if (failure instanceof InferenceNotFoundError) {
      return new InferenceNotFoundError({ message, ...receiptField(failure.receipt) });
    }
    if (failure instanceof InferenceInternalServerError) {
      return new InferenceInternalServerError({ message, ...receiptField(failure.receipt) });
    }
    if (failure instanceof InferenceUnavailableError) {
      return new InferenceUnavailableError({ message });
    }
    const budget: BudgetExceededError = failure;
    return budget;
  };

/** Everything an exchange answers, success or failure, leaves with its login's secrets redacted. */
const withinExchange = <A, R>(exchange: Exchange, effect: Effect.Effect<A, RespondFailure, R>) =>
  effect.pipe(Effect.mapError(redactFailure(redacting(exchange))));

const answerTurn = (
  exchange: Exchange,
  engineTurn: InferenceEngineTurn,
): InferenceRespondResponse => {
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
            toolCallId: call.toolCallId,
            name: redact(call.name),
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

const failTurn = (exchange: Exchange, raw: InferenceEngineError) =>
  Effect.gen(function* () {
    const { receipt } = exchange;
    const { message } = raw;
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
  turn: Effect.Effect<InferenceEngineTurn, InferenceEngineError, R>,
) =>
  turn.pipe(
    Effect.catch((error) => failTurn(exchange, error)),
    Effect.map((engineTurn) => answerTurn(exchange, engineTurn)),
  );

const continueExchange = (
  payload: InferenceRespondRequest & { readonly sessionId: string },
  toolResults: NonNullable<InferenceRespondRequest["toolResults"]>,
) =>
  Effect.gen(function* () {
    const engine = yield* InferenceEngine;
    const exchange = engine.exchange(payload.sessionId);
    // Another owner's session answers exactly like one that does not exist.
    if (exchange === undefined || exchange.ownerUserId !== payload.ownerUserId) {
      return yield* new InferenceNotFoundError({
        message: `Inference session not found (or expired): ${payload.sessionId}. Start the exchange over.`,
      });
    }
    return yield* withinExchange(
      exchange,
      settleTurn(exchange, engine.continueSession({ sessionId: payload.sessionId, toolResults })),
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

    const resolved = kindReceipt(account);

    // Inference IS the credential use — a non-active account is a hard error either way.
    if (account.status !== "active") {
      return yield* new InferenceConflictError({
        message: `Connected ${account.provider} account "${account.name}" is invalid — reconnect it.`,
        ...receiptField(resolved),
      });
    }

    const cipher = yield* CredentialCipher;
    const payloadJson = yield* cipher.decrypt(account.encryptedPayload).pipe(
      Effect.mapError(
        (error) =>
          new InferenceInternalServerError({
            message: toErrorMessage(error, "Failed to decrypt the connected account credential."),
            ...receiptField(resolved),
          }),
      ),
    );
    const { login, loginClass } = yield* readLogin(account, payloadJson, resolved);
    const exchange = openExchange({
      ownerUserId: payload.ownerUserId,
      receipt: { accountId: account.id, revision: account.credentialRevision, login: loginClass },
      login,
    });
    return yield* withinExchange(exchange, runExchange(exchange, account, payload));
  });

const runExchange = (
  exchange: Exchange,
  account: ConnectedAccount,
  payload: InferenceRespondRequest,
) =>
  Effect.gen(function* () {
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
    const accounts = yield* ConnectedAccountRepo;
    yield* accounts.updateSyncState({ id: account.id, lastUsedAt: new Date() }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Failed to stamp last_used_at for connected account ${account.id}; continuing.`,
          cause,
        ),
      ),
      Effect.asVoid,
    );

    return yield* settleTurn(exchange, startEngine(exchange, payload));
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
  }).pipe(Effect.mapError(redactFailure(redactProviderKeys)));

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
