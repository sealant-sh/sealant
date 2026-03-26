import { randomUUID } from "node:crypto";

import type { GitHubAppInstallation } from "@sealant/db";
import type { GitHubRemoteInstallation } from "@sealant/source-integrations";
import type { Context } from "hono";

import type { AppBindings } from "../../lib/types.js";
import type {
  importGitHubInstallationRequestSchema,
  importGitHubInstallationResponseSchema,
  githubInstallationRepositoriesQuerySchema,
  githubInstallationsQuerySchema,
  githubInstallationSummarySchema,
  githubInstallationRepositorySummarySchema,
  syncGitHubInstallationQuerySchema,
  syncGitHubInstallationResponseSchema,
} from "./github.routes.js";

const toIsoString = (value: Date | null | undefined): string | undefined => {
  return value?.toISOString();
};

const gitHubUnavailable = (c: Context<AppBindings>) => {
  return c.json(
    {
      message: "GitHub integration is not configured.",
    },
    503,
  );
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

const toInstallationSummary = (
  installation: GitHubAppInstallation,
): typeof githubInstallationSummarySchema._type => {
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

const upsertInstallationRecord = async (
  c: Context<AppBindings>,
  input: {
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
  },
): Promise<GitHubAppInstallation | null> => {
  const installationRepository = c.get("gitHubInstallationRepository");

  if (installationRepository === undefined) {
    return null;
  }

  const existing = await installationRepository.getInstallationByExternalId(
    input.externalInstallationId,
  );
  const now = new Date();

  return installationRepository.upsertInstallation({
    id: existing?.id ?? randomUUID(),
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
  });
};

const upsertInstallationFromWebhook = async (
  c: Context<AppBindings>,
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
  const now = new Date();

  return upsertInstallationRecord(c, {
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
  c: Context<AppBindings>,
  installation: GitHubAppInstallation,
): Promise<number> => {
  const gitHubSourceIntegration = c.get("gitHubSourceIntegration");
  const installationRepositoryCache = c.get("gitHubInstallationRepositoryCacheRepository");
  const repositoryProfileRepository = c.get("repositoryProfileRepository");
  const installationRepository = c.get("gitHubInstallationRepository");

  if (
    gitHubSourceIntegration === undefined ||
    installationRepositoryCache === undefined ||
    repositoryProfileRepository === undefined ||
    installationRepository === undefined
  ) {
    throw new Error("GitHub sync dependencies are not configured.");
  }

  const syncedAt = new Date();
  const remoteRepositories = await gitHubSourceIntegration.listInstallationRepositories(
    installation.externalInstallationId,
  );
  const preservedExternalRepositoryIds: string[] = [];

  for (const remoteRepository of remoteRepositories) {
    const existingRepository = await repositoryProfileRepository.getRepositoryByProviderExternalId({
      provider: "github",
      externalId: remoteRepository.externalRepositoryId,
    });
    const repository = await repositoryProfileRepository.upsertRepository({
      id: existingRepository?.id ?? randomUUID(),
      provider: "github",
      externalId: remoteRepository.externalRepositoryId,
      owner: remoteRepository.owner,
      name: remoteRepository.name,
      defaultBranch: remoteRepository.defaultBranch,
      url: remoteRepository.url,
      isArchived: remoteRepository.isArchived,
      lastSyncedAt: syncedAt,
    });
    const existingInstallationRepository =
      await installationRepositoryCache.getInstallationRepositoryByExternalRepoId({
        installationId: installation.id,
        externalRepositoryId: remoteRepository.externalRepositoryId,
      });

    await installationRepositoryCache.upsertInstallationRepository({
      id: existingInstallationRepository?.id ?? randomUUID(),
      installationId: installation.id,
      repositoryId: repository.id,
      externalRepositoryId: remoteRepository.externalRepositoryId,
      owner: remoteRepository.owner,
      name: remoteRepository.name,
      fullName: remoteRepository.fullName,
      defaultBranch: remoteRepository.defaultBranch,
      isPrivate: remoteRepository.isPrivate,
      isArchived: remoteRepository.isArchived,
      ...(remoteRepository.pushedAt === undefined ? {} : { pushedAt: remoteRepository.pushedAt }),
      lastSyncedAt: syncedAt,
      removedAt: null,
    });

    preservedExternalRepositoryIds.push(remoteRepository.externalRepositoryId);
  }

  await installationRepositoryCache.markInstallationRepositoriesRemoved({
    installationId: installation.id,
    preservedExternalRepositoryIds,
    removedAt: syncedAt,
  });
  await installationRepository.setInstallationStatus({
    installationId: installation.id,
    status: installation.status === "deleted" ? "deleted" : "active",
    ...(installation.status === "deleted" ? {} : { suspendedAt: null }),
    lastSyncedAt: syncedAt,
  });

  return remoteRepositories.length;
};

const importInstallationState = async (
  c: Context<AppBindings>,
  externalInstallationId: string,
): Promise<GitHubAppInstallation> => {
  const gitHubSourceIntegration = c.get("gitHubSourceIntegration");

  if (gitHubSourceIntegration === undefined || !gitHubSourceIntegration.isConfigured()) {
    throw new Error("GitHub integration is not configured.");
  }

  const remoteInstallation = await gitHubSourceIntegration.getInstallation(externalInstallationId);
  const installation = await upsertInstallationRecord(c, {
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
    throw new Error("GitHub installation repository is not configured.");
  }

  return installation;
};

export const listInstallations = async (c: Context<AppBindings>) => {
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): typeof githubInstallationsQuerySchema._type;
    }
  ).valid("query");
  const installationRepository = c.get("gitHubInstallationRepository");

  if (installationRepository === undefined) {
    return gitHubUnavailable(c);
  }

  const installations = await installationRepository.listInstallationsForUser({
    userId: query.userId,
    status: "active",
  });
  const items: Array<typeof githubInstallationSummarySchema._type> =
    installations.map(toInstallationSummary);

  return c.json({ items });
};

export const listInstallationRepositories = async (c: Context<AppBindings>) => {
  const params = (
    c.req as typeof c.req & {
      valid(target: "param"): { installationId: string };
    }
  ).valid("param");
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): typeof githubInstallationRepositoriesQuerySchema._type;
    }
  ).valid("query");
  const installationRepository = c.get("gitHubInstallationRepository");
  const installationRepositoryCache = c.get("gitHubInstallationRepositoryCacheRepository");

  if (installationRepository === undefined || installationRepositoryCache === undefined) {
    return gitHubUnavailable(c);
  }

  const installation = await installationRepository.getInstallationById(params.installationId);
  if (installation === undefined) {
    return c.json(
      {
        message: `GitHub installation not found: ${params.installationId}`,
      },
      404,
    );
  }

  const hasGrant = await installationRepository.userHasInstallationGrant({
    installationId: installation.id,
    userId: query.userId,
  });
  if (!hasGrant) {
    return c.json(
      {
        message: `User ${query.userId} does not have access to GitHub installation ${params.installationId}.`,
      },
      403,
    );
  }

  const repositories = await installationRepositoryCache.listRepositoriesForUser({
    userId: query.userId,
    installationId: params.installationId,
    ...(query.search === undefined ? {} : { search: query.search }),
  });
  const items: Array<typeof githubInstallationRepositorySummarySchema._type> = repositories.map(
    (repository) => {
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
    },
  );

  return c.json({ items });
};

export const syncInstallation = async (c: Context<AppBindings>) => {
  const params = (
    c.req as typeof c.req & {
      valid(target: "param"): { installationId: string };
    }
  ).valid("param");
  const query = (
    c.req as typeof c.req & {
      valid(target: "query"): typeof syncGitHubInstallationQuerySchema._type;
    }
  ).valid("query");
  const installationRepository = c.get("gitHubInstallationRepository");
  const gitHubSourceIntegration = c.get("gitHubSourceIntegration");

  if (
    installationRepository === undefined ||
    gitHubSourceIntegration === undefined ||
    !gitHubSourceIntegration.isConfigured()
  ) {
    return gitHubUnavailable(c);
  }

  const installation = await installationRepository.getInstallationById(params.installationId);
  if (installation === undefined) {
    return c.json(
      {
        message: `GitHub installation not found: ${params.installationId}`,
      },
      404,
    );
  }

  if (installation.status !== "active") {
    return c.json(
      {
        message: `GitHub installation ${params.installationId} is not active.`,
      },
      403,
    );
  }

  const hasGrant = await installationRepository.userHasInstallationGrant({
    installationId: installation.id,
    userId: query.userId,
  });

  if (!hasGrant) {
    return c.json(
      {
        message: `User ${query.userId} does not have access to GitHub installation ${params.installationId}.`,
      },
      403,
    );
  }

  const syncedAt = new Date();
  const syncedRepositoryCount = await syncInstallationRepositories(c, installation);
  const response: typeof syncGitHubInstallationResponseSchema._type = {
    installationId: installation.id,
    syncedRepositoryCount,
    syncedAt: syncedAt.toISOString(),
  };

  return c.json(response);
};

export const importInstallation = async (c: Context<AppBindings>) => {
  const body = (
    c.req as typeof c.req & {
      valid(target: "json"): typeof importGitHubInstallationRequestSchema._type;
    }
  ).valid("json");
  const installationRepository = c.get("gitHubInstallationRepository");
  const gitHubSourceIntegration = c.get("gitHubSourceIntegration");

  if (
    installationRepository === undefined ||
    gitHubSourceIntegration === undefined ||
    !gitHubSourceIntegration.isConfigured()
  ) {
    return gitHubUnavailable(c);
  }

  try {
    const installation = await importInstallationState(c, body.externalInstallationId);

    await installationRepository.grantInstallationToUser({
      installationId: installation.id,
      userId: body.userId,
      grantedByUserId: body.userId,
    });

    const syncedAt = new Date();
    const syncedRepositoryCount =
      installation.status === "active" ? await syncInstallationRepositories(c, installation) : 0;
    const response: typeof importGitHubInstallationResponseSchema._type = {
      installation: toInstallationSummary(
        syncedRepositoryCount === 0 && installation.status !== "active"
          ? installation
          : ((await installationRepository.getInstallationById(installation.id)) ?? installation),
      ),
      syncedRepositoryCount,
      syncedAt: syncedAt.toISOString(),
    };

    return c.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub installation import failed.";
    const status = message.includes("status 404") ? 404 : 500;

    return c.json(
      {
        message,
      },
      status,
    );
  }
};

export const handleWebhook = async (c: Context<AppBindings>) => {
  const gitHubSourceIntegration = c.get("gitHubSourceIntegration");
  const webhookRepository = c.get("gitHubWebhookDeliveryRepository");

  if (gitHubSourceIntegration === undefined || webhookRepository === undefined) {
    return gitHubUnavailable(c);
  }

  if (!gitHubSourceIntegration.isWebhookVerificationConfigured()) {
    return c.json(
      {
        message: "GitHub webhook verification is not configured.",
      },
      503,
    );
  }

  const deliveryId = c.req.header("x-github-delivery");
  const eventType = c.req.header("x-github-event");
  const signature256 = c.req.header("x-hub-signature-256");

  if (deliveryId === undefined || eventType === undefined) {
    return c.json(
      {
        message: "GitHub webhook delivery headers are missing.",
      },
      400,
    );
  }

  const payloadText = await c.req.text();
  if (!gitHubSourceIntegration.verifyWebhookSignature({ payload: payloadText, signature256 })) {
    return c.json(
      {
        message: "GitHub webhook signature verification failed.",
      },
      401,
    );
  }

  const payload = parseWebhookPayload(payloadText);
  const action = typeof payload.action === "string" ? payload.action : undefined;
  const installationExternalId = getWebhookInstallationExternalId(payload);
  const existingDelivery = await webhookRepository.getWebhookDeliveryByDeliveryId(deliveryId);

  if (existingDelivery !== undefined && existingDelivery.status !== "received") {
    return c.json(
      {
        deliveryId,
        status: existingDelivery.status,
      },
      202,
    );
  }

  const delivery = await webhookRepository.createWebhookDelivery({
    id: existingDelivery?.id ?? randomUUID(),
    deliveryId,
    eventType,
    ...(action === undefined ? {} : { action }),
    ...(installationExternalId === undefined ? {} : { installationExternalId }),
    payload,
  });

  try {
    const installation = await upsertInstallationFromWebhook(c, payload, action);

    if (
      installation !== null &&
      installation.status === "active" &&
      (eventType === "installation" || eventType === "installation_repositories")
    ) {
      await syncInstallationRepositories(c, installation);
    }

    const processedStatus = installation === null ? "ignored" : "processed";
    await webhookRepository.markWebhookDeliveryProcessed({
      deliveryId,
      status: processedStatus,
    });

    return c.json(
      {
        deliveryId: delivery.deliveryId,
        status: processedStatus,
      },
      202,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub webhook processing failed.";
    await webhookRepository.markWebhookDeliveryFailed({
      deliveryId,
      errorMessage: message,
    });

    return c.json(
      {
        message,
      },
      500,
    );
  }
};
