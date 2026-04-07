import { HttpApiBuilder, HttpApiScalar, HttpServer } from "@effect/platform";
import {
  GitHubApi,
  GitHubBadRequestError,
  GitHubForbiddenError,
  GitHubInternalServerError,
  GitHubNotFoundError,
  GitHubServiceUnavailableError,
  GitHubUnauthorizedError,
} from "@sealant/api-contracts";
import type { GitHubAppInstallation } from "@sealant/db";
import type { GitHubRemoteInstallation } from "@sealant/source-integrations";
import { Effect, Layer } from "effect";

import { createApiRuntime } from "../../lib/create-api-runtime.js";
import type { AppRuntimeConfig } from "../../lib/types.js";

const gitHubUnavailableMessage = "GitHub integration is not configured.";

const toErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

const runResult = async <A>(result: Effect.Effect<A, unknown, never> | Promise<A> | A) => {
  if (Effect.isEffect(result)) {
    return Effect.runPromise(result);
  }

  return await result;
};

const isKnownGitHubError = (
  error: unknown,
): error is
  | GitHubBadRequestError
  | GitHubUnauthorizedError
  | GitHubForbiddenError
  | GitHubNotFoundError
  | GitHubServiceUnavailableError
  | GitHubInternalServerError => {
  return (
    error instanceof GitHubBadRequestError ||
    error instanceof GitHubUnauthorizedError ||
    error instanceof GitHubForbiddenError ||
    error instanceof GitHubNotFoundError ||
    error instanceof GitHubServiceUnavailableError ||
    error instanceof GitHubInternalServerError
  );
};

const toIsoString = (value: Date | null | undefined): string | undefined => {
  return value?.toISOString();
};

const parseWebhookPayload = (payload: string): Record<string, unknown> => {
  const parsed = JSON.parse(payload) as unknown;

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("GitHub webhook payload must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
};

const getWebhookInstallationExternalId = (payload: Record<string, unknown>): string | undefined => {
  const installation = payload.installation;

  if (typeof installation !== "object" || installation === null || !("id" in installation)) {
    return undefined;
  }

  const externalId = installation.id;
  if (typeof externalId !== "number" && typeof externalId !== "string") {
    return undefined;
  }

  return String(externalId);
};

const toInstallationStatus = (action: string | undefined): GitHubAppInstallation["status"] => {
  switch (action) {
    case "deleted":
      return "deleted";
    case "suspend":
      return "suspended";
    default:
      return "active";
  }
};

const toInstallationSummary = (installation: GitHubAppInstallation) => {
  return {
    installationId: installation.id,
    externalInstallationId: installation.externalInstallationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    status: installation.status,
    repositorySelection: installation.repositorySelection,
    ...(installation.lastSyncedAt === null
      ? {}
      : { lastSyncedAt: toIsoString(installation.lastSyncedAt) }),
  };
};

const toInstallationStatusFromRemote = (
  installation: Pick<GitHubRemoteInstallation, "suspendedAt">,
): GitHubAppInstallation["status"] => {
  return installation.suspendedAt === undefined ? "active" : "suspended";
};

const createGitHubHandlers = (config: AppRuntimeConfig) => {
  const runtime = createApiRuntime(config);

  const upsertInstallationRecord = async (input: {
    readonly externalInstallationId: string;
    readonly externalAccountId?: string;
    readonly accountLogin: string;
    readonly accountType: GitHubAppInstallation["accountType"];
    readonly targetType?: GitHubAppInstallation["accountType"];
    readonly status: GitHubAppInstallation["status"];
    readonly permissions?: Record<string, string>;
    readonly repositorySelection: GitHubAppInstallation["repositorySelection"];
    readonly suspendedAt?: Date | null;
    readonly lastSyncedAt?: Date;
    readonly installedAt?: Date;
  }): Promise<GitHubAppInstallation | null> => {
    const installationRepository = runtime.gitHubInstallationRepository;

    if (installationRepository === undefined) {
      return null;
    }

    const existing = await runResult(
      installationRepository.getInstallationByExternalId(input.externalInstallationId),
    );
    const now = runtime.clock.now();

    return runResult(
      installationRepository.upsertInstallation({
        id: existing?.id ?? runtime.idGenerator.randomUuid(),
        externalInstallationId: input.externalInstallationId,
        ...(input.externalAccountId === undefined
          ? {}
          : { externalAccountId: input.externalAccountId }),
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        ...(input.targetType === undefined ? {} : { targetType: input.targetType }),
        status: input.status,
        ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
        repositorySelection: input.repositorySelection,
        ...(input.suspendedAt === undefined ? {} : { suspendedAt: input.suspendedAt }),
        lastSyncedAt: input.lastSyncedAt ?? now,
        installedAt: input.installedAt ?? existing?.installedAt ?? now,
      }),
    );
  };

  const upsertInstallationFromWebhook = async (
    payload: Record<string, unknown>,
    action: string | undefined,
  ): Promise<GitHubAppInstallation | null> => {
    const installation = payload.installation;
    if (typeof installation !== "object" || installation === null) {
      return null;
    }

    const externalInstallationId = getWebhookInstallationExternalId(payload);
    const account = "account" in installation ? installation.account : undefined;

    if (
      externalInstallationId === undefined ||
      typeof account !== "object" ||
      account === null ||
      !("login" in account) ||
      typeof account.login !== "string"
    ) {
      return null;
    }

    const accountType =
      "type" in account && account.type === "Organization" ? "organization" : "user";
    const targetType =
      "target_type" in installation && installation.target_type === "Organization"
        ? "organization"
        : "target_type" in installation && installation.target_type === "User"
          ? "user"
          : accountType;
    const externalAccountId =
      "id" in account && (typeof account.id === "number" || typeof account.id === "string")
        ? String(account.id)
        : undefined;
    const permissions =
      "permissions" in installation && typeof installation.permissions === "object"
        ? Object.fromEntries(
            Object.entries(installation.permissions ?? {}).filter(
              (entry): entry is [string, string] => {
                return typeof entry[1] === "string";
              },
            ),
          )
        : undefined;
    const now = runtime.clock.now();

    return upsertInstallationRecord({
      externalInstallationId,
      ...(externalAccountId === undefined ? {} : { externalAccountId }),
      accountLogin: account.login,
      accountType,
      targetType,
      status: toInstallationStatus(action),
      ...(permissions === undefined ? {} : { permissions }),
      repositorySelection: payload.repository_selection === "selected" ? "selected" : "all",
      suspendedAt: toInstallationStatus(action) === "suspended" ? now : null,
      lastSyncedAt: now,
      installedAt: now,
    });
  };

  const syncInstallationRepositories = async (
    installation: GitHubAppInstallation,
  ): Promise<number> => {
    const gitHubSourceIntegration = runtime.gitHubSourceIntegration;
    const installationRepositoryCache = runtime.gitHubInstallationRepositoryCacheRepository;
    const repositoryProfileRepository = runtime.repositoryProfileRepository;
    const installationRepository = runtime.gitHubInstallationRepository;

    if (
      gitHubSourceIntegration === undefined ||
      installationRepositoryCache === undefined ||
      repositoryProfileRepository === undefined ||
      installationRepository === undefined
    ) {
      throw new GitHubServiceUnavailableError({
        message: "GitHub sync dependencies are not configured.",
      });
    }

    const syncedAt = runtime.clock.now();
    const remoteRepositories = await runResult(
      gitHubSourceIntegration.listInstallationRepositories(installation.externalInstallationId),
    );
    const preservedExternalRepositoryIds: string[] = [];

    for (const remoteRepository of remoteRepositories) {
      const existingRepository = await runResult(
        repositoryProfileRepository.getRepositoryByProviderExternalId({
          provider: "github",
          externalId: remoteRepository.externalRepositoryId,
        }),
      );
      const repository = await runResult(
        repositoryProfileRepository.upsertRepository({
          id: existingRepository?.id ?? runtime.idGenerator.randomUuid(),
          provider: "github",
          externalId: remoteRepository.externalRepositoryId,
          owner: remoteRepository.owner,
          name: remoteRepository.name,
          defaultBranch: remoteRepository.defaultBranch,
          url: remoteRepository.url,
          isArchived: remoteRepository.isArchived,
          lastSyncedAt: syncedAt,
        }),
      );
      const existingInstallationRepository = await runResult(
        installationRepositoryCache.getInstallationRepositoryByExternalRepoId({
          installationId: installation.id,
          externalRepositoryId: remoteRepository.externalRepositoryId,
        }),
      );

      await runResult(
        installationRepositoryCache.upsertInstallationRepository({
          id: existingInstallationRepository?.id ?? runtime.idGenerator.randomUuid(),
          installationId: installation.id,
          repositoryId: repository.id,
          externalRepositoryId: remoteRepository.externalRepositoryId,
          owner: remoteRepository.owner,
          name: remoteRepository.name,
          fullName: remoteRepository.fullName,
          defaultBranch: remoteRepository.defaultBranch,
          isPrivate: remoteRepository.isPrivate,
          isArchived: remoteRepository.isArchived,
          ...(remoteRepository.pushedAt === undefined
            ? {}
            : { pushedAt: remoteRepository.pushedAt }),
          lastSyncedAt: syncedAt,
          removedAt: null,
        }),
      );

      preservedExternalRepositoryIds.push(remoteRepository.externalRepositoryId);
    }

    await runResult(
      installationRepositoryCache.markInstallationRepositoriesRemoved({
        installationId: installation.id,
        preservedExternalRepositoryIds,
        removedAt: syncedAt,
      }),
    );
    await runResult(
      installationRepository.setInstallationStatus({
        installationId: installation.id,
        status: installation.status === "deleted" ? "deleted" : "active",
        ...(installation.status === "deleted" ? {} : { suspendedAt: null }),
        lastSyncedAt: syncedAt,
      }),
    );

    return remoteRepositories.length;
  };

  const importInstallationState = async (
    externalInstallationId: string,
  ): Promise<GitHubAppInstallation> => {
    const gitHubSourceIntegration = runtime.gitHubSourceIntegration;

    if (gitHubSourceIntegration === undefined || !gitHubSourceIntegration.isConfigured()) {
      throw new GitHubServiceUnavailableError({ message: gitHubUnavailableMessage });
    }

    const remoteInstallation = await runResult(
      gitHubSourceIntegration.getInstallation(externalInstallationId),
    );
    const installation = await upsertInstallationRecord({
      externalInstallationId: remoteInstallation.externalInstallationId,
      ...(remoteInstallation.externalAccountId === undefined
        ? {}
        : { externalAccountId: remoteInstallation.externalAccountId }),
      accountLogin: remoteInstallation.accountLogin,
      accountType: remoteInstallation.accountType,
      targetType: remoteInstallation.targetType,
      status: toInstallationStatusFromRemote(remoteInstallation),
      permissions: remoteInstallation.permissions,
      repositorySelection: remoteInstallation.repositorySelection,
      suspendedAt: remoteInstallation.suspendedAt ?? null,
    });

    if (installation === null) {
      throw new GitHubServiceUnavailableError({
        message: "GitHub installation repository is not configured.",
      });
    }

    return installation;
  };

  const listInstallations = (userId: string) =>
    Effect.tryPromise({
      try: async () => {
        const installationRepository = runtime.gitHubInstallationRepository;

        if (installationRepository === undefined) {
          throw new GitHubServiceUnavailableError({ message: gitHubUnavailableMessage });
        }

        const installations = await runResult(
          installationRepository.listInstallationsForUser({
            userId,
            status: "active",
          }),
        );

        return {
          items: installations.map(toInstallationSummary),
        };
      },
      catch: (error) => {
        if (isKnownGitHubError(error)) {
          return error;
        }

        return new GitHubInternalServerError({
          message: toErrorMessage(error, "Failed to list GitHub installations."),
        });
      },
    });

  const listInstallationRepositories = (input: {
    readonly installationId: string;
    readonly userId: string;
    readonly search?: string;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const installationRepository = runtime.gitHubInstallationRepository;
        const installationRepositoryCache = runtime.gitHubInstallationRepositoryCacheRepository;

        if (installationRepository === undefined || installationRepositoryCache === undefined) {
          throw new GitHubServiceUnavailableError({ message: gitHubUnavailableMessage });
        }

        const installation = await runResult(
          installationRepository.getInstallationById(input.installationId),
        );
        if (installation === undefined) {
          throw new GitHubNotFoundError({
            message: `GitHub installation not found: ${input.installationId}`,
          });
        }

        const hasGrant = await runResult(
          installationRepository.userHasInstallationGrant({
            installationId: installation.id,
            userId: input.userId,
          }),
        );

        if (!hasGrant) {
          throw new GitHubForbiddenError({
            message: `User ${input.userId} does not have access to GitHub installation ${input.installationId}.`,
          });
        }

        const repositories = await runResult(
          installationRepositoryCache.listRepositoriesForUser({
            userId: input.userId,
            installationId: input.installationId,
            ...(input.search === undefined ? {} : { search: input.search }),
          }),
        );

        return {
          items: repositories.map((repository) => {
            return {
              installationRepositoryId: repository.id,
              installationId: repository.installationId,
              repositoryId: repository.repositoryId,
              externalRepositoryId: repository.externalRepositoryId,
              owner: repository.owner,
              name: repository.name,
              fullName: repository.fullName,
              defaultBranch: repository.defaultBranch,
              isPrivate: repository.isPrivate,
              isArchived: repository.isArchived,
              ...(repository.lastSyncedAt === null
                ? {}
                : { lastSyncedAt: toIsoString(repository.lastSyncedAt) }),
            };
          }),
        };
      },
      catch: (error) => {
        if (isKnownGitHubError(error)) {
          return error;
        }

        return new GitHubInternalServerError({
          message: toErrorMessage(error, "Failed to list GitHub installation repositories."),
        });
      },
    });

  const syncInstallation = (input: { readonly installationId: string; readonly userId: string }) =>
    Effect.tryPromise({
      try: async () => {
        const installationRepository = runtime.gitHubInstallationRepository;
        const gitHubSourceIntegration = runtime.gitHubSourceIntegration;

        if (
          installationRepository === undefined ||
          gitHubSourceIntegration === undefined ||
          !gitHubSourceIntegration.isConfigured()
        ) {
          throw new GitHubServiceUnavailableError({ message: gitHubUnavailableMessage });
        }

        const installation = await runResult(
          installationRepository.getInstallationById(input.installationId),
        );
        if (installation === undefined) {
          throw new GitHubNotFoundError({
            message: `GitHub installation not found: ${input.installationId}`,
          });
        }

        if (installation.status !== "active") {
          throw new GitHubForbiddenError({
            message: `GitHub installation ${input.installationId} is not active.`,
          });
        }

        const hasGrant = await runResult(
          installationRepository.userHasInstallationGrant({
            installationId: installation.id,
            userId: input.userId,
          }),
        );

        if (!hasGrant) {
          throw new GitHubForbiddenError({
            message: `User ${input.userId} does not have access to GitHub installation ${input.installationId}.`,
          });
        }

        const syncedAt = runtime.clock.now();
        const syncedRepositoryCount = await syncInstallationRepositories(installation);

        return {
          installationId: installation.id,
          syncedRepositoryCount,
          syncedAt: syncedAt.toISOString(),
        };
      },
      catch: (error) => {
        if (isKnownGitHubError(error)) {
          return error;
        }

        return new GitHubInternalServerError({
          message: toErrorMessage(error, "GitHub installation sync failed."),
        });
      },
    });

  const importInstallation = (input: {
    readonly userId: string;
    readonly externalInstallationId: string;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const installationRepository = runtime.gitHubInstallationRepository;
        const gitHubSourceIntegration = runtime.gitHubSourceIntegration;

        if (
          installationRepository === undefined ||
          gitHubSourceIntegration === undefined ||
          !gitHubSourceIntegration.isConfigured()
        ) {
          throw new GitHubServiceUnavailableError({ message: gitHubUnavailableMessage });
        }

        try {
          const installation = await importInstallationState(input.externalInstallationId);

          await runResult(
            installationRepository.grantInstallationToUser({
              installationId: installation.id,
              userId: input.userId,
              grantedByUserId: input.userId,
            }),
          );

          const syncedAt = runtime.clock.now();
          const syncedRepositoryCount =
            installation.status === "active" ? await syncInstallationRepositories(installation) : 0;

          const latestInstallation =
            syncedRepositoryCount === 0 && installation.status !== "active"
              ? installation
              : ((await runResult(installationRepository.getInstallationById(installation.id))) ??
                installation);

          return {
            installation: toInstallationSummary(latestInstallation),
            syncedRepositoryCount,
            syncedAt: syncedAt.toISOString(),
          };
        } catch (error) {
          const message = toErrorMessage(error, "GitHub installation import failed.");

          if (isKnownGitHubError(error)) {
            throw error;
          }

          if (message.includes("status 404")) {
            throw new GitHubNotFoundError({ message });
          }

          throw new GitHubInternalServerError({ message });
        }
      },
      catch: (error) => {
        if (isKnownGitHubError(error)) {
          return error;
        }

        return new GitHubInternalServerError({
          message: toErrorMessage(error, "GitHub installation import failed."),
        });
      },
    });

  const handleWebhook = (input: {
    readonly deliveryIdHeader?: string;
    readonly eventTypeHeader?: string;
    readonly signatureHeader?: string;
    readonly payloadText: string;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const gitHubSourceIntegration = runtime.gitHubSourceIntegration;
        const webhookRepository = runtime.gitHubWebhookDeliveryRepository;

        if (gitHubSourceIntegration === undefined || webhookRepository === undefined) {
          throw new GitHubServiceUnavailableError({ message: gitHubUnavailableMessage });
        }

        if (!gitHubSourceIntegration.isWebhookVerificationConfigured()) {
          throw new GitHubServiceUnavailableError({
            message: "GitHub webhook verification is not configured.",
          });
        }

        const deliveryId = input.deliveryIdHeader;
        const eventType = input.eventTypeHeader;
        const signature256 = input.signatureHeader;

        if (deliveryId === undefined || eventType === undefined) {
          throw new GitHubBadRequestError({
            message: "GitHub webhook delivery headers are missing.",
          });
        }

        if (
          !gitHubSourceIntegration.verifyWebhookSignature({
            payload: input.payloadText,
            signature256,
          })
        ) {
          throw new GitHubUnauthorizedError({
            message: "GitHub webhook signature verification failed.",
          });
        }

        const payload = parseWebhookPayload(input.payloadText);
        const action = typeof payload.action === "string" ? payload.action : undefined;
        const installationExternalId = getWebhookInstallationExternalId(payload);
        const existingDelivery = await runResult(
          webhookRepository.getWebhookDeliveryByDeliveryId(deliveryId),
        );

        if (existingDelivery !== undefined && existingDelivery.status !== "received") {
          return {
            deliveryId,
            status: existingDelivery.status,
          };
        }

        const delivery = await runResult(
          webhookRepository.createWebhookDelivery({
            id: existingDelivery?.id ?? runtime.idGenerator.randomUuid(),
            deliveryId,
            eventType,
            ...(action === undefined ? {} : { action }),
            ...(installationExternalId === undefined ? {} : { installationExternalId }),
            payload,
          }),
        );

        try {
          const installation = await upsertInstallationFromWebhook(payload, action);

          if (
            installation !== null &&
            installation.status === "active" &&
            (eventType === "installation" || eventType === "installation_repositories")
          ) {
            await syncInstallationRepositories(installation);
          }

          const processedStatus = installation === null ? "ignored" : "processed";
          await runResult(
            webhookRepository.markWebhookDeliveryProcessed({
              deliveryId,
              status: processedStatus,
            }),
          );

          return {
            deliveryId: delivery.deliveryId,
            status: processedStatus,
          };
        } catch (error) {
          const message = toErrorMessage(error, "GitHub webhook processing failed.");
          await runResult(
            webhookRepository.markWebhookDeliveryFailed({
              deliveryId,
              errorMessage: message,
            }),
          );

          throw new GitHubInternalServerError({ message });
        }
      },
      catch: (error) => {
        if (isKnownGitHubError(error)) {
          return error;
        }

        return new GitHubInternalServerError({
          message: toErrorMessage(error, "GitHub webhook processing failed."),
        });
      },
    });

  return HttpApiBuilder.group(GitHubApi, "github", (handlers) => {
    return handlers
      .handle("listInstallations", ({ urlParams }) => listInstallations(urlParams.userId))
      .handle("listInstallationRepositories", ({ path, urlParams }) =>
        listInstallationRepositories({
          installationId: path.installationId,
          userId: urlParams.userId,
          ...(urlParams.search === undefined ? {} : { search: urlParams.search }),
        }),
      )
      .handle("syncInstallation", ({ path, urlParams }) =>
        syncInstallation({
          installationId: path.installationId,
          userId: urlParams.userId,
        }),
      )
      .handle("importInstallation", ({ payload }) =>
        importInstallation({
          userId: payload.userId,
          externalInstallationId: payload.externalInstallationId,
        }),
      )
      .handle("handleWebhook", ({ headers, payload }) =>
        handleWebhook({
          deliveryIdHeader: headers["x-github-delivery"],
          eventTypeHeader: headers["x-github-event"],
          signatureHeader: headers["x-hub-signature-256"],
          payloadText: payload,
        }),
      );
  });
};

export const createGitHubWebHandler = (config: AppRuntimeConfig) => {
  const GitHubHandlersLive = createGitHubHandlers(config);

  const GitHubApiLive = HttpApiBuilder.api(GitHubApi).pipe(Layer.provide(GitHubHandlersLive));
  const GitHubOpenApiLive = HttpApiBuilder.middlewareOpenApi({ path: "/openapi.json" }).pipe(
    Layer.provide(GitHubApiLive),
  );
  const GitHubDocsLive = HttpApiScalar.layer({
    path: "/docs",
    scalar: {
      theme: "saturn",
      layout: "classic",
      darkMode: true,
      defaultOpenAllTags: false,
    },
  }).pipe(Layer.provide(GitHubApiLive));

  const { handler } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(GitHubApiLive, GitHubOpenApiLive, GitHubDocsLive, HttpServer.layerContext),
  );

  return handler;
};
