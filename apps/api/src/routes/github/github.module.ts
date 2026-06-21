import { randomUUID } from "node:crypto";

import {
  GitHubBadRequestError,
  GitHubForbiddenError,
  type GitHubInstallationRepositoriesQuery,
  type GitHubInstallationRepositorySummary,
  type GitHubInstallationSummary,
  type GitHubInstallationsQuery,
  GitHubInternalServerError,
  type GitHubWebhookResponse,
  GitHubNotFoundError,
  GitHubServiceUnavailableError,
  type ImportGitHubInstallationRequest,
  type ImportGitHubInstallationResponse,
  type ListGitHubInstallationRepositoriesResponse,
  type ListGitHubInstallationsResponse,
  type SyncGitHubInstallationQuery,
  type SyncGitHubInstallationResponse,
  GitHubUnauthorizedError,
} from "@sealant/api-contracts";
import {
  GitHubInstallationRepo,
  GitHubInstallationRepositoryCacheRepo,
  GitHubWebhookDeliveryRepo,
  RepositoryProfileRepo,
  type GitHubAppInstallation,
} from "@sealant/db";
import {
  GitHubSourceIntegrationHttpError,
  type GitHubRemoteInstallation,
  GitHubSourceIntegrationService,
} from "@sealant/source-integrations";
import { Clock, Effect } from "effect";

const gitHubUnavailableMessage = "GitHub integration is not configured.";

const toErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis));

const randomId = Effect.sync(() => randomUUID());

const toIsoString = (value: Date | null | undefined): string | undefined => {
  return value?.toISOString();
};

const parseWebhookPayload = (payload: string) => {
  return Effect.try({
    try: () => {
      const parsed = JSON.parse(payload) as unknown;

      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("GitHub webhook payload must be a JSON object.");
      }

      return parsed as Record<string, unknown>;
    },
    catch: () =>
      new GitHubBadRequestError({
        message: "GitHub webhook payload must be a JSON object.",
      }),
  });
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

const toInstallationSummary = (installation: GitHubAppInstallation): GitHubInstallationSummary => {
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

const withInternalError = <A>(effect: Effect.Effect<A, unknown>, fallback: string) => {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new GitHubInternalServerError({
          message: toErrorMessage(error, fallback),
        }),
    ),
  );
};

const upsertInstallationRecord = (input: {
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
}) => {
  return Effect.gen(function* () {
    const installationRepo = yield* GitHubInstallationRepo;
    const existing = yield* withInternalError(
      installationRepo.getInstallationByExternalId(input.externalInstallationId),
      "Failed to load GitHub installation.",
    );
    const currentTime = yield* now;
    const id = existing?.id ?? (yield* randomId);

    return yield* withInternalError(
      installationRepo.upsertInstallation({
        id,
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
        lastSyncedAt: input.lastSyncedAt ?? currentTime,
        installedAt: input.installedAt ?? existing?.installedAt ?? currentTime,
      }),
      "Failed to upsert GitHub installation.",
    );
  });
};

const upsertInstallationFromWebhook = (
  payload: Record<string, unknown>,
  action: string | undefined,
) => {
  return Effect.gen(function* () {
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
    const currentTime = yield* now;

    return yield* upsertInstallationRecord({
      externalInstallationId,
      ...(externalAccountId === undefined ? {} : { externalAccountId }),
      accountLogin: account.login,
      accountType,
      targetType,
      status: toInstallationStatus(action),
      ...(permissions === undefined ? {} : { permissions }),
      repositorySelection: payload.repository_selection === "selected" ? "selected" : "all",
      suspendedAt: toInstallationStatus(action) === "suspended" ? currentTime : null,
      lastSyncedAt: currentTime,
      installedAt: currentTime,
    });
  });
};

const syncInstallationRepositories = (installation: GitHubAppInstallation) => {
  return Effect.gen(function* () {
    const sourceIntegration = yield* GitHubSourceIntegrationService;
    const installationCacheRepo = yield* GitHubInstallationRepositoryCacheRepo;
    const repositoryProfileRepo = yield* RepositoryProfileRepo;
    const installationRepo = yield* GitHubInstallationRepo;

    const syncedAt = yield* now;
    const remoteRepositories = yield* withInternalError(
      sourceIntegration.listInstallationRepositories(installation.externalInstallationId),
      "Failed to list repositories for GitHub installation.",
    );

    const preservedExternalRepositoryIds: string[] = [];

    for (const remoteRepository of remoteRepositories) {
      const existingRepository = yield* withInternalError(
        repositoryProfileRepo.getRepositoryByProviderExternalId({
          provider: "github",
          externalId: remoteRepository.externalRepositoryId,
        }),
        "Failed to load repository profile.",
      );

      const repositoryId = existingRepository?.id ?? (yield* randomId);

      const repository = yield* withInternalError(
        repositoryProfileRepo.upsertRepository({
          id: repositoryId,
          provider: "github",
          externalId: remoteRepository.externalRepositoryId,
          owner: remoteRepository.owner,
          name: remoteRepository.name,
          defaultBranch: remoteRepository.defaultBranch,
          url: remoteRepository.url,
          isArchived: remoteRepository.isArchived,
          lastSyncedAt: syncedAt,
        }),
        "Failed to upsert repository profile.",
      );

      const existingInstallationRepository = yield* withInternalError(
        installationCacheRepo.getInstallationRepositoryByExternalRepoId({
          installationId: installation.id,
          externalRepositoryId: remoteRepository.externalRepositoryId,
        }),
        "Failed to load installation repository cache entry.",
      );

      const installationRepositoryId = existingInstallationRepository?.id ?? (yield* randomId);

      yield* withInternalError(
        installationCacheRepo.upsertInstallationRepository({
          id: installationRepositoryId,
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
        "Failed to upsert installation repository cache entry.",
      );

      preservedExternalRepositoryIds.push(remoteRepository.externalRepositoryId);
    }

    yield* withInternalError(
      installationCacheRepo.markInstallationRepositoriesRemoved({
        installationId: installation.id,
        preservedExternalRepositoryIds,
        removedAt: syncedAt,
      }),
      "Failed to mark stale installation repositories as removed.",
    );

    yield* withInternalError(
      installationRepo.setInstallationStatus({
        installationId: installation.id,
        status: installation.status === "deleted" ? "deleted" : "active",
        ...(installation.status === "deleted" ? {} : { suspendedAt: null }),
        lastSyncedAt: syncedAt,
      }),
      "Failed to update GitHub installation status after sync.",
    );

    return remoteRepositories.length;
  });
};

const importInstallationState = (externalInstallationId: string) => {
  return Effect.gen(function* () {
    const sourceIntegration = yield* GitHubSourceIntegrationService;

    if (!sourceIntegration.isConfigured()) {
      return yield* new GitHubServiceUnavailableError({ message: gitHubUnavailableMessage });
    }

    const remoteInstallation = yield* sourceIntegration
      .getInstallation(externalInstallationId)
      .pipe(
        Effect.mapError((error) => {
          const message = toErrorMessage(error, "GitHub installation import failed.");
          if (error instanceof GitHubSourceIntegrationHttpError && error.statusCode === 404) {
            return new GitHubNotFoundError({ message });
          }

          return new GitHubInternalServerError({ message });
        }),
      );

    return yield* upsertInstallationRecord({
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
  });
};

export const listInstallations = (query: GitHubInstallationsQuery) => {
  return Effect.gen(function* () {
    const installationRepo = yield* GitHubInstallationRepo;
    const installations = yield* withInternalError(
      installationRepo.listInstallationsForUser({
        userId: query.userId,
        status: "active",
      }),
      "Failed to list GitHub installations.",
    );

    return {
      items: installations.map(toInstallationSummary),
    } satisfies ListGitHubInstallationsResponse;
  });
};

export const listInstallationRepositories = (input: {
  readonly installationId: string;
  readonly query: GitHubInstallationRepositoriesQuery;
}) => {
  return Effect.gen(function* () {
    const installationRepo = yield* GitHubInstallationRepo;
    const installationCacheRepo = yield* GitHubInstallationRepositoryCacheRepo;

    const installation = yield* withInternalError(
      installationRepo.getInstallationById(input.installationId),
      "Failed to load GitHub installation.",
    );

    if (installation === undefined) {
      return yield* new GitHubNotFoundError({
        message: `GitHub installation not found: ${input.installationId}`,
      });
    }

    const hasGrant = yield* withInternalError(
      installationRepo.userHasInstallationGrant({
        installationId: installation.id,
        userId: input.query.userId,
      }),
      "Failed to verify GitHub installation access.",
    );

    if (!hasGrant) {
      return yield* new GitHubForbiddenError({
        message: `User ${input.query.userId} does not have access to GitHub installation ${input.installationId}.`,
      });
    }

    const repositories = yield* withInternalError(
      installationCacheRepo.listRepositoriesForUser({
        userId: input.query.userId,
        installationId: input.installationId,
        ...(input.query.search === undefined ? {} : { search: input.query.search }),
      }),
      "Failed to list GitHub installation repositories.",
    );

    return {
      items: repositories.map((repository): GitHubInstallationRepositorySummary => {
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
    } satisfies ListGitHubInstallationRepositoriesResponse;
  });
};

export const syncInstallation = (input: {
  readonly installationId: string;
  readonly query: SyncGitHubInstallationQuery;
}) => {
  return Effect.gen(function* () {
    const installationRepo = yield* GitHubInstallationRepo;
    const sourceIntegration = yield* GitHubSourceIntegrationService;

    if (!sourceIntegration.isConfigured()) {
      return yield* new GitHubServiceUnavailableError({ message: gitHubUnavailableMessage });
    }

    const installation = yield* withInternalError(
      installationRepo.getInstallationById(input.installationId),
      "Failed to load GitHub installation.",
    );

    if (installation === undefined) {
      return yield* new GitHubNotFoundError({
        message: `GitHub installation not found: ${input.installationId}`,
      });
    }

    if (installation.status !== "active") {
      return yield* new GitHubForbiddenError({
        message: `GitHub installation ${input.installationId} is not active.`,
      });
    }

    const hasGrant = yield* withInternalError(
      installationRepo.userHasInstallationGrant({
        installationId: installation.id,
        userId: input.query.userId,
      }),
      "Failed to verify GitHub installation access.",
    );

    if (!hasGrant) {
      return yield* new GitHubForbiddenError({
        message: `User ${input.query.userId} does not have access to GitHub installation ${input.installationId}.`,
      });
    }

    const syncedAt = yield* now;
    const syncedRepositoryCount = yield* syncInstallationRepositories(installation);

    return {
      installationId: installation.id,
      syncedRepositoryCount,
      syncedAt: syncedAt.toISOString(),
    } satisfies SyncGitHubInstallationResponse;
  });
};

export const importInstallation = (input: ImportGitHubInstallationRequest) => {
  return Effect.gen(function* () {
    const installationRepo = yield* GitHubInstallationRepo;
    const sourceIntegration = yield* GitHubSourceIntegrationService;

    if (!sourceIntegration.isConfigured()) {
      return yield* new GitHubServiceUnavailableError({ message: gitHubUnavailableMessage });
    }

    const installation = yield* importInstallationState(input.externalInstallationId);

    yield* withInternalError(
      installationRepo.grantInstallationToUser({
        installationId: installation.id,
        userId: input.userId,
        grantedByUserId: input.userId,
      }),
      "Failed to grant GitHub installation access.",
    );

    const syncedAt = yield* now;
    const syncedRepositoryCount =
      installation.status === "active" ? yield* syncInstallationRepositories(installation) : 0;

    const latestInstallation =
      syncedRepositoryCount === 0 && installation.status !== "active"
        ? installation
        : ((yield* withInternalError(
            installationRepo.getInstallationById(installation.id),
            "Failed to refresh GitHub installation after import.",
          )) ?? installation);

    return {
      installation: toInstallationSummary(latestInstallation),
      syncedRepositoryCount,
      syncedAt: syncedAt.toISOString(),
    } satisfies ImportGitHubInstallationResponse;
  });
};

export const handleWebhook = (input: {
  readonly deliveryIdHeader?: string;
  readonly eventTypeHeader?: string;
  readonly signatureHeader?: string;
  readonly payloadText: string;
}) => {
  return Effect.gen(function* () {
    const sourceIntegration = yield* GitHubSourceIntegrationService;
    const webhookRepo = yield* GitHubWebhookDeliveryRepo;

    if (!sourceIntegration.isWebhookVerificationConfigured()) {
      return yield* new GitHubServiceUnavailableError({
        message: "GitHub webhook verification is not configured.",
      });
    }

    const deliveryId = input.deliveryIdHeader;
    const eventType = input.eventTypeHeader;
    const signature256 = input.signatureHeader;

    if (deliveryId === undefined || eventType === undefined) {
      return yield* new GitHubBadRequestError({
        message: "GitHub webhook delivery headers are missing.",
      });
    }

    if (
      !sourceIntegration.verifyWebhookSignature({
        payload: input.payloadText,
        signature256,
      })
    ) {
      return yield* new GitHubUnauthorizedError({
        message: "GitHub webhook signature verification failed.",
      });
    }

    const payload = yield* parseWebhookPayload(input.payloadText);
    const action = typeof payload.action === "string" ? payload.action : undefined;
    const installationExternalId = getWebhookInstallationExternalId(payload);

    const existingDelivery = yield* withInternalError(
      webhookRepo.getWebhookDeliveryByDeliveryId(deliveryId),
      "Failed to load existing webhook delivery.",
    );

    if (existingDelivery !== undefined && existingDelivery.status !== "received") {
      return {
        deliveryId,
        status: existingDelivery.status,
      } satisfies GitHubWebhookResponse;
    }

    const createdDelivery = yield* withInternalError(
      webhookRepo.createWebhookDelivery({
        id: existingDelivery?.id ?? (yield* randomId),
        deliveryId,
        eventType,
        ...(action === undefined ? {} : { action }),
        ...(installationExternalId === undefined ? {} : { installationExternalId }),
        payload,
      }),
      "Failed to create webhook delivery.",
    );

    const processWebhook = Effect.gen(function* () {
      const installation = yield* upsertInstallationFromWebhook(payload, action);

      if (
        installation !== null &&
        installation.status === "active" &&
        (eventType === "installation" || eventType === "installation_repositories")
      ) {
        yield* syncInstallationRepositories(installation);
      }

      const processedStatus = installation === null ? "ignored" : "processed";

      yield* withInternalError(
        webhookRepo.markWebhookDeliveryProcessed({
          deliveryId,
          status: processedStatus,
        }),
        "Failed to mark webhook delivery as processed.",
      );

      return {
        deliveryId: createdDelivery.deliveryId,
        status: processedStatus,
      } satisfies GitHubWebhookResponse;
    });

    return yield* processWebhook.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message = toErrorMessage(error, "GitHub webhook processing failed.");

          yield* withInternalError(
            webhookRepo.markWebhookDeliveryFailed({
              deliveryId,
              errorMessage: message,
            }),
            "Failed to mark webhook delivery as failed.",
          );

          return yield* new GitHubInternalServerError({ message });
        }),
      ),
    );
  });
};
