import { randomUUID } from "node:crypto";

import type { GitHubAppInstallation } from "@sealant/db";
import type { Context } from "hono";

import type { AppBindings } from "../../lib/types.js";
import type {
  githubInstallationRepositoriesQuerySchema,
  githubInstallationsQuerySchema,
  githubInstallationSummarySchema,
  githubInstallationRepositorySummarySchema,
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

const upsertInstallationFromWebhook = async (
  c: Context<AppBindings>,
  payload: Record<string, unknown>,
  action: string | undefined,
): Promise<GitHubAppInstallation | null> => {
  const installationRepository = c.get("gitHubInstallationRepository");

  if (installationRepository === undefined) {
    return null;
  }

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
  const externalAccountId =
    "id" in account && (typeof account.id === "number" || typeof account.id === "string")
      ? String(account.id)
      : undefined;
  const existing = await installationRepository.getInstallationByExternalId(externalInstallationId);
  const now = new Date();

  return installationRepository.upsertInstallation({
    id: existing?.id ?? randomUUID(),
    externalInstallationId,
    ...(externalAccountId === undefined ? {} : { externalAccountId }),
    accountLogin: account.login,
    accountType,
    targetType: accountType,
    status: toInstallationStatus(action),
    repositorySelection: payload.repository_selection === "selected" ? "selected" : "all",
    ...(toInstallationStatus(action) === "suspended"
      ? { suspendedAt: now }
      : { suspendedAt: null }),
    lastSyncedAt: now,
    installedAt: existing?.installedAt ?? now,
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
      pushedAt: remoteRepository.pushedAt,
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
  const items: Array<typeof githubInstallationSummarySchema._type> = installations.map(
    (installation) => {
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
    },
  );

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
    search: query.search,
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
  const installationRepository = c.get("gitHubInstallationRepository");
  const gitHubSourceIntegration = c.get("gitHubSourceIntegration");

  if (installationRepository === undefined || gitHubSourceIntegration === undefined) {
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

  const syncedAt = new Date();
  const syncedRepositoryCount = await syncInstallationRepositories(c, installation);
  const response: typeof syncGitHubInstallationResponseSchema._type = {
    installationId: installation.id,
    syncedRepositoryCount,
    syncedAt: syncedAt.toISOString(),
  };

  return c.json(response);
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
    action,
    installationExternalId: getWebhookInstallationExternalId(payload),
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
