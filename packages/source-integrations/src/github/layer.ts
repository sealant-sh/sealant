import { createHmac, createPrivateKey, sign, timingSafeEqual } from "node:crypto";

import { Effect, Layer } from "effect";

import {
  GitHubSourceIntegrationConfig,
  type GitHubSourceIntegration,
  type GitHubSourceIntegrationError,
  GitHubSourceIntegrationHttpError,
  GitHubSourceIntegrationInvariantError,
  type GitHubSourceIntegrationOperation,
  GitHubSourceIntegrationService,
  GitHubSourceIntegrationUnexpectedError,
  type GitHubSourceIntegrationOptions,
} from "./service.js";
import {
  base64UrlEncode,
  defaultGitHubApiBaseUrl,
  normalizePrivateKey,
  parseInstallationResponse,
  parseInstallationTokenResponse,
  parseRepositoriesResponse,
  toAuthorizationHeaders,
} from "./utils.js";

const mapGitHubSourceIntegrationError = (
  operation: GitHubSourceIntegrationOperation,
  cause: unknown,
): GitHubSourceIntegrationError => {
  if (
    cause instanceof GitHubSourceIntegrationInvariantError ||
    cause instanceof GitHubSourceIntegrationHttpError ||
    cause instanceof GitHubSourceIntegrationUnexpectedError
  ) {
    return cause;
  }

  return new GitHubSourceIntegrationUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withGitHubSourceIntegrationError = <A>(
  operation: GitHubSourceIntegrationOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, GitHubSourceIntegrationError> => {
  return effect.pipe(Effect.mapError((cause) => mapGitHubSourceIntegrationError(operation, cause)));
};

const makeGitHubSourceIntegration = (
  options: GitHubSourceIntegrationOptions,
): GitHubSourceIntegration => {
  const appId = options.appId;
  const privateKey = options.privateKey;
  const webhookSecret = options.webhookSecret;
  const apiBaseUrl = options.apiBaseUrl ?? defaultGitHubApiBaseUrl;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  const isConfigured = () => {
    return appId !== undefined && privateKey !== undefined;
  };

  const isWebhookVerificationConfigured = () => {
    return webhookSecret !== undefined;
  };

  const createAppJwt = () =>
    withGitHubSourceIntegrationError(
      "createAppJwt",
      Effect.try(() => {
        if (appId === undefined || privateKey === undefined) {
          throw new GitHubSourceIntegrationInvariantError({
            operation: "createAppJwt",
            message: "GitHub App credentials are not configured.",
          });
        }

        const issuedAtSeconds = Math.floor(now().getTime() / 1000) - 60;
        const expiresAtSeconds = issuedAtSeconds + 9 * 60;
        const encodedHeader = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
        const encodedPayload = base64UrlEncode(
          JSON.stringify({
            iat: issuedAtSeconds,
            exp: expiresAtSeconds,
            iss: appId,
          }),
        );
        const signingInput = `${encodedHeader}.${encodedPayload}`;
        const signature = sign(
          "RSA-SHA256",
          Buffer.from(signingInput, "utf8"),
          createPrivateKey(normalizePrivateKey(privateKey)),
        )
          .toString("base64")
          .replace(/=/g, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_");

        return `${signingInput}.${signature}`;
      }),
    );

  const verifyWebhookSignature: GitHubSourceIntegration["verifyWebhookSignature"] = (input) => {
    if (webhookSecret === undefined || input.signature256 === undefined) {
      return false;
    }

    const expected = `sha256=${createHmac("sha256", webhookSecret).update(input.payload).digest("hex")}`;
    const expectedBuffer = Buffer.from(expected, "utf8");
    const receivedBuffer = Buffer.from(input.signature256, "utf8");

    return (
      expectedBuffer.length === receivedBuffer.length &&
      timingSafeEqual(expectedBuffer, receivedBuffer)
    );
  };

  const requestJson = <A>(input: {
    readonly operation: GitHubSourceIntegrationOperation;
    readonly url: string;
    readonly init?: RequestInit;
    readonly parse: (payload: unknown) => A;
    readonly errorContext: string;
  }) => {
    return withGitHubSourceIntegrationError(
      input.operation,
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise(() => fetchImpl(input.url, input.init));

        if (!response.ok) {
          return yield* new GitHubSourceIntegrationHttpError({
            operation: input.operation,
            statusCode: response.status,
            message: `${input.errorContext} failed with status ${response.status}.`,
          });
        }

        const payload = yield* Effect.tryPromise(() => response.json());

        return yield* Effect.try(() => input.parse(payload));
      }),
    );
  };

  const createInstallationAccessToken: GitHubSourceIntegration["createInstallationAccessToken"] = (
    externalInstallationId,
  ) => {
    return Effect.gen(function* () {
      const appJwt = yield* createAppJwt();

      return yield* requestJson({
        operation: "createInstallationAccessToken",
        url: `${apiBaseUrl}/app/installations/${encodeURIComponent(externalInstallationId)}/access_tokens`,
        init: {
          method: "POST",
          headers: {
            ...toAuthorizationHeaders(appJwt),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
        parse: parseInstallationTokenResponse,
        errorContext: "GitHub installation token request",
      });
    });
  };

  const getInstallation: GitHubSourceIntegration["getInstallation"] = (externalInstallationId) => {
    return Effect.gen(function* () {
      const appJwt = yield* createAppJwt();

      return yield* requestJson({
        operation: "getInstallation",
        url: `${apiBaseUrl}/app/installations/${encodeURIComponent(externalInstallationId)}`,
        init: {
          headers: toAuthorizationHeaders(appJwt),
        },
        parse: parseInstallationResponse,
        errorContext: "GitHub installation request",
      });
    });
  };

  const listInstallationRepositories: GitHubSourceIntegration["listInstallationRepositories"] = (
    externalInstallationId,
  ) => {
    return Effect.gen(function* () {
      const installationToken = yield* createInstallationAccessToken(externalInstallationId);
      const repositories = [] as Array<ReturnType<typeof parseRepositoriesResponse>[number]>;
      let page = 1;

      while (true) {
        const pageRepositories = yield* requestJson({
          operation: "listInstallationRepositories",
          url: `${apiBaseUrl}/installation/repositories?per_page=100&page=${page}`,
          init: {
            headers: toAuthorizationHeaders(installationToken.token),
          },
          parse: parseRepositoriesResponse,
          errorContext: "GitHub installation repositories request",
        });

        repositories.push(...pageRepositories);

        if (pageRepositories.length < 100) {
          break;
        }

        page += 1;
      }

      return repositories;
    });
  };

  return {
    isConfigured,
    isWebhookVerificationConfigured,
    createAppJwt,
    verifyWebhookSignature,
    createInstallationAccessToken,
    getInstallation,
    listInstallationRepositories,
  };
};

export const gitHubSourceIntegrationLiveLayer = Layer.effect(
  GitHubSourceIntegrationService,
  Effect.gen(function* () {
    const options = yield* GitHubSourceIntegrationConfig;

    return makeGitHubSourceIntegration(options);
  }),
);

export const gitHubSourceIntegrationLayer = (options: GitHubSourceIntegrationOptions = {}) => {
  const configLayer = Layer.succeed(GitHubSourceIntegrationConfig, options);

  return gitHubSourceIntegrationLiveLayer.pipe(Layer.provide(configLayer));
};

export const createGitHubSourceIntegration = (options: GitHubSourceIntegrationOptions = {}) => {
  return Effect.runSync(
    GitHubSourceIntegrationService.pipe(Effect.provide(gitHubSourceIntegrationLayer(options))),
  );
};
