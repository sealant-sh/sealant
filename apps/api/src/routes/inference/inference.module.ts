/**
 * Inference route handlers — inference on connected accounts, via the official agent SDKs.
 *
 * Flow (design doc §9): resolve the caller's account REFERENCE (same shape and ownership semantics
 * as workspace creation), decrypt the stored credential, hand it to the provider's engine —
 * {@link InferenceEngine} (the official Claude Agent SDK) for claude accounts,
 * {@link CodexInferenceEngine} (the official Codex CLI) for codex accounts — and stamp
 * `last_used_at`, the same per-account attribution workspace injection does. A live auth failure
 * on a setup-token claude account marks it invalid (the in-process equivalent of the
 * `mark-invalid` 401-feedback endpoint); self-refreshing credentials (claude session files, codex
 * auth.json) get a 409 "reconnect" instead. No handler ever returns or logs secret material;
 * engine errors pass through `redactSecret` before leaving this module.
 */
import {
  InferenceBadRequestError,
  InferenceConflictError,
  InferenceInternalServerError,
  InferenceNotFoundError,
  InferenceUnavailableError,
  type InferenceRespondRequest,
  type InferenceRespondResponse,
  type InferenceTurn,
} from "@sealant/api-contracts";
import {
  CredentialCipher,
  extractClaudeOauthCredentials,
  extractCodexSecrets,
  parseClaudeCredentialPayload,
  parseCodexCredentialPayload,
  provisionClaudeConfigDir,
  provisionCodexHome,
  readClaudeConfigDirCredentials,
  readCodexHomeAuthJson,
  removeClaudeConfigDir,
  removeCodexHome,
  type ClaudeOauthCredentials,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ProfileRepo,
  type ConnectedAccount,
  type ConnectedAccountRepoService,
} from "@sealant/db";
import { persistClaudeCredentialsIfNewer, persistCodexAuthJsonIfNewer } from "@sealant/workspaces";
import { Effect, Layer } from "effect";

import { env } from "../../runtime-env.js";
import {
  InferenceEngine,
  InferenceEngineError,
  type InferenceEngineTurn,
} from "./claude-engine.js";
import { CodexInferenceEngine } from "./codex-engine.js";
import { redactSecrets } from "./support.js";

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

    const accounts = yield* ConnectedAccountRepo;

    const resolveExplicit = (provider: "claude" | "codex", explicit: string) =>
      Effect.gen(function* () {
        const account = explicit.startsWith("cacc_")
          ? yield* withInternalError(
              accounts.getById(explicit),
              "Failed to load connected account.",
            )
          : yield* withInternalError(
              accounts.getByOwnerProviderName({
                ownerUserId: input.ownerUserId,
                provider,
                name: explicit,
              }),
              "Failed to load connected account.",
            );
        // Uniform 404: unknown, someone else's, wrong-provider, and archived all look identical.
        if (
          account === undefined ||
          account.ownerUserId !== input.ownerUserId ||
          account.provider !== provider ||
          account.archivedAt !== null
        ) {
          return yield* new InferenceNotFoundError({
            message: `No ${provider} connected account matches "${explicit}".`,
          });
        }
        return account;
      });

    let account: ConnectedAccount | undefined;

    if (credentials.claude !== undefined) {
      account = yield* resolveExplicit("claude", credentials.claude);
    } else if (credentials.codex !== undefined) {
      account = yield* resolveExplicit("codex", credentials.codex);
    } else if (credentials.profileId !== undefined) {
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

const mapEngineTurn = (engineTurn: InferenceEngineTurn): InferenceRespondResponse => {
  const turn: InferenceTurn =
    engineTurn.turn.type === "done"
      ? {
          type: "text",
          text: engineTurn.turn.text,
          ...(engineTurn.turn.json === undefined ? {} : { json: engineTurn.turn.json }),
        }
      : { type: "toolCalls", calls: engineTurn.turn.calls };
  return {
    sessionId: engineTurn.sessionId,
    turn,
    ...(engineTurn.turn.type === "done" && engineTurn.turn.usage !== undefined
      ? { usage: engineTurn.turn.usage }
      : {}),
  };
};

/** Maps engine failures to contract errors; `accountId` enables 401-feedback on auth failures. */
const mapEngineError = (error: InferenceEngineError) => {
  switch (error.reason) {
    case "session-not-found": {
      return new InferenceNotFoundError({ message: error.message });
    }
    case "bad-tool-result": {
      return new InferenceBadRequestError({ message: error.message });
    }
    case "auth": {
      return new InferenceConflictError({
        message: `The connected account was rejected by the provider — reconnect it. (${error.message})`,
      });
    }
    case "timeout":
    case "engine": {
      return new InferenceInternalServerError({ message: error.message });
    }
  }
};

/**
 * The codex arm of a new exchange. Tool-less v1: codex has no in-process MCP transport, so
 * caller-defined tools are a 400 until a parked-tool transport ships (`maxTurns` is likewise
 * claude-only and ignored here — a codex exchange settles in one turn). Auth failures are a 409
 * ("reconnect") WITHOUT markInvalid — auth.json self-refreshes at point of use exactly like a
 * claude session file, so marking it invalid would needlessly block workspace launches on a
 * credential that may still rotate itself back to health.
 */
const respondWithCodex = (input: {
  readonly account: ConnectedAccount;
  readonly payload: InferenceRespondRequest;
  readonly payloadJson: string;
  readonly cipher: CredentialCipherService;
  readonly accounts: ConnectedAccountRepoService;
}) =>
  Effect.gen(function* () {
    const { account, payload, cipher, accounts } = input;

    if ((payload.tools ?? []).length > 0) {
      return yield* new InferenceBadRequestError({
        message:
          "Codex inference does not support caller-defined tools yet — run tool exchanges on a claude connected account.",
      });
    }

    const engine = yield* CodexInferenceEngine;

    const authJson = yield* Effect.try({
      try: () => parseCodexCredentialPayload(JSON.parse(input.payloadJson)).authJson,
      catch: () =>
        new InferenceInternalServerError({
          message: "Stored codex credential payload is malformed.",
        }),
    });
    // Every token-like value auth.json carries, kept ONLY for redacting engine error text.
    const secrets = extractCodexSecrets(authJson);

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

    // Materialize the decrypted auth.json into a private per-invocation CODEX_HOME (0700/0600)
    // the engine points the official CLI at. When the exchange ends — success or failure — the
    // possibly-rotated file is read back and persisted through the same newest-wins guard the
    // workspace sync-back uses, then the dir is removed. The repo and cipher service INSTANCES
    // are captured here because the hook runs outside any request scope.
    const provisioned = yield* Effect.try({
      try: () => provisionCodexHome({ authJson }),
      catch: (cause) =>
        new InferenceInternalServerError({
          message: toErrorMessage(cause, "Failed to provision the codex home dir."),
        }),
    });

    const persistRotatedAuthJson = Effect.gen(function* () {
      const observed = readCodexHomeAuthJson(provisioned.codexHome);
      if (observed === undefined) {
        yield* Effect.logWarning(
          `Codex auth.json (inference refresh): account ${account.id} failed-read: provisioned home has no readable auth.json.`,
        );
        return;
      }
      yield* persistCodexAuthJsonIfNewer({
        connectedAccountId: account.id,
        observedAuthJson: observed,
        credentialCipher: cipher,
        source: "inference refresh",
      });
    }).pipe(
      Effect.ensuring(Effect.sync(() => removeCodexHome(provisioned.codexHome))),
      Effect.provide(Layer.succeed(ConnectedAccountRepo, accounts)),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Codex auth.json (inference refresh): account ${account.id} failed: persisting after the exchange crashed.`,
          cause,
        ),
      ),
      Effect.asVoid,
    );

    const engineTurn = yield* engine
      .start({
        codexHome: provisioned.codexHome,
        secrets,
        prompt: payload.prompt ?? "",
        ...(payload.system === undefined ? {} : { system: payload.system }),
        ...(payload.model === undefined ? {} : { model: payload.model }),
        ...(payload.responseFormat === undefined ? {} : { responseFormat: payload.responseFormat }),
        onSessionEnd: () => Effect.runPromise(persistRotatedAuthJson),
      })
      .pipe(
        Effect.mapError(
          (error) => new InferenceEngineError(error.reason, redactSecrets(error.message, secrets)),
        ),
        Effect.mapError((error) =>
          error.reason === "auth"
            ? new InferenceConflictError({
                message:
                  "The codex session could not authenticate. auth.json refreshes automatically at use, so this usually means the refresh token itself was revoked (e.g. by logging out of that session elsewhere) — reconnect the account.",
              })
            : mapEngineError(error),
        ),
      );

    return mapEngineTurn(engineTurn);
  });

export const respond = (payload: InferenceRespondRequest) =>
  Effect.gen(function* () {
    const isNew = payload.prompt !== undefined;
    const isContinuation = payload.sessionId !== undefined || payload.toolResults !== undefined;
    if (isNew === isContinuation) {
      return yield* new InferenceBadRequestError({
        message:
          "Send either a new exchange (credentials + prompt) or a continuation (sessionId + toolResults), not both or neither.",
      });
    }

    const engine = yield* InferenceEngine;

    if (isContinuation) {
      if (payload.sessionId === undefined || payload.toolResults === undefined) {
        return yield* new InferenceBadRequestError({
          message: "A continuation requires both sessionId and toolResults.",
        });
      }
      const engineTurn = yield* engine
        .continueSession({ sessionId: payload.sessionId, toolResults: payload.toolResults })
        .pipe(Effect.mapError(mapEngineError));
      return mapEngineTurn(engineTurn);
    }

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

    if (account.provider === "codex") {
      return yield* respondWithCodex({ account, payload, payloadJson, cipher, accounts });
    }
    // Either claude payload shape works here. A setup-token rides the documented
    // CLAUDE_CODE_OAUTH_TOKEN env path. A session credentials file is materialized into a private
    // per-invocation CLAUDE_CONFIG_DIR instead, so the official CLI authenticates from the FILE —
    // and can rotate the session with its refresh token right at the point of use (the control
    // plane never calls Anthropic's token endpoint). The shape drives the 401-feedback policy
    // below; the access and refresh tokens are kept ONLY for redacting engine error text.
    const oauthCredentials = yield* Effect.try({
      try: (): ClaudeOauthCredentials & {
        readonly shape: "token" | "credentials-json";
        readonly credentialsJson: string | undefined;
      } => {
        const parsed = parseClaudeCredentialPayload(JSON.parse(payloadJson));

        if ("token" in parsed) {
          return {
            shape: "token",
            accessToken: parsed.token,
            refreshToken: undefined,
            credentialsJson: undefined,
          };
        }

        const extracted = extractClaudeOauthCredentials(parsed.credentialsJson);

        if (extracted === undefined) {
          throw new Error("credentials.json payload is unusable");
        }

        return { shape: "credentials-json", credentialsJson: parsed.credentialsJson, ...extracted };
      },
      catch: () =>
        new InferenceInternalServerError({
          message: "Stored claude credential payload is malformed.",
        }),
    });

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

    // Session-file accounts: materialize the decrypted file into a private per-invocation config
    // dir (0700/0600) the engine points the official CLI at. When the session ends — success,
    // failure, or idle expiry — the possibly-rotated file is read back and persisted through the
    // same newest-wins guards the workspace sync-back uses, then the dir is removed. The repo and
    // cipher service INSTANCES are captured here because the hook runs outside any request scope.
    const sessionAuth = yield* Effect.try({
      try: () => {
        if (oauthCredentials.shape === "token" || oauthCredentials.credentialsJson === undefined) {
          return {
            auth: { kind: "oauth-token", oauthToken: oauthCredentials.accessToken },
            onSessionEnd: undefined,
          } as const;
        }

        const provisioned = provisionClaudeConfigDir({
          credentialsJson: oauthCredentials.credentialsJson,
        });

        const persistRotatedCredentials = Effect.gen(function* () {
          const observed = readClaudeConfigDirCredentials(provisioned.configDir);
          if (observed === undefined) {
            yield* Effect.logWarning(
              `Claude credentials (inference refresh): account ${account.id} failed-read: provisioned config dir has no readable .credentials.json.`,
            );
            return;
          }
          yield* persistClaudeCredentialsIfNewer({
            connectedAccountId: account.id,
            observedCredentialsJson: observed,
            credentialCipher: cipher,
            source: "inference refresh",
          });
        }).pipe(
          Effect.ensuring(Effect.sync(() => removeClaudeConfigDir(provisioned.configDir))),
          Effect.provide(Layer.succeed(ConnectedAccountRepo, accounts)),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `Claude credentials (inference refresh): account ${account.id} failed: persisting after the session crashed.`,
              cause,
            ),
          ),
          Effect.asVoid,
        );

        return {
          auth: {
            kind: "config-dir",
            configDir: provisioned.configDir,
            accessToken: oauthCredentials.accessToken,
          },
          onSessionEnd: () => Effect.runPromise(persistRotatedCredentials),
        } as const;
      },
      catch: (cause) =>
        new InferenceInternalServerError({
          message: toErrorMessage(cause, "Failed to provision the claude session config dir."),
        }),
    });

    const engineTurn = yield* engine
      .start({
        auth: sessionAuth.auth,
        ...(sessionAuth.onSessionEnd === undefined
          ? {}
          : { onSessionEnd: sessionAuth.onSessionEnd }),
        prompt: payload.prompt ?? "",
        ...(payload.system === undefined ? {} : { system: payload.system }),
        ...(payload.model === undefined ? {} : { model: payload.model }),
        ...(payload.maxTurns === undefined ? {} : { maxTurns: payload.maxTurns }),
        tools: payload.tools ?? [],
        ...(payload.responseFormat === undefined ? {} : { responseFormat: payload.responseFormat }),
      })
      .pipe(
        Effect.mapError((error) => {
          const redacted = new InferenceEngineError(
            error.reason,
            redactSecrets(error.message, [
              oauthCredentials.accessToken,
              oauthCredentials.refreshToken,
            ]),
          );
          return redacted;
        }),
        // 401 feedback: a live auth rejection marks the account invalid (design doc §2), the same
        // signal the worker's mark-invalid endpoint carries — best-effort, the caller's error
        // wins. Setup tokens ONLY: a session file runs through the config-dir path where the
        // official CLI refreshes the session itself, and the stored credential stays refreshable
        // — marking it invalid here would needlessly block every workspace launch on the account.
        Effect.tapError((error) =>
          error.reason === "auth" && oauthCredentials.shape === "token"
            ? accounts.markInvalid({ id: account.id }).pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.mapError((error) =>
          error.reason === "auth" && oauthCredentials.shape === "credentials-json"
            ? new InferenceConflictError({
                message:
                  "The claude session could not authenticate. The session refreshes automatically at use and on a schedule, so this usually means the refresh token itself was revoked (e.g. by logging out of that session elsewhere) — reconnect the account with a fresh session file.",
              })
            : mapEngineError(error),
        ),
      );

    return mapEngineTurn(engineTurn);
  });
