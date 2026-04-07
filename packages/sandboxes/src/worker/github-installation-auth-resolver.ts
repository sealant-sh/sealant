import {
  createGitHubInstallationRepository,
  createGitHubInstallationRepositoryCacheRepository,
  type DatabaseClient,
} from "@sealant/db";
import {
  parseGitHubInstallationRepositoryAuthRef,
  type GitHubSourceIntegration,
} from "@sealant/source-integrations";
import type { NewSandbox } from "@sealant/validators";

import type { SandboxCloneAuth } from "../runtime/index.js";

const createWorkerError = (code: string, message: string) => {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
};

const resolveInstallationAccessToken = async (input: {
  readonly authRef: string | undefined;
  readonly dbClient: DatabaseClient;
  readonly gitHubSourceIntegration: GitHubSourceIntegration | undefined;
  readonly unavailableIntegrationMessage: string;
  readonly unavailableRepositoryContext: string;
  readonly missingInstallationContext: string;
  readonly inactiveInstallationContext: string;
}): Promise<string | undefined> => {
  const installationRepositoryId = parseGitHubInstallationRepositoryAuthRef(input.authRef);

  if (installationRepositoryId === undefined) {
    return undefined;
  }

  if (
    input.gitHubSourceIntegration === undefined ||
    !input.gitHubSourceIntegration.isConfigured()
  ) {
    throw createWorkerError("github-integration-unavailable", input.unavailableIntegrationMessage);
  }

  const installationRepositoryCache = createGitHubInstallationRepositoryCacheRepository(
    input.dbClient,
  );
  const installationRepository = createGitHubInstallationRepository(input.dbClient);
  const installationRepositoryRecord =
    await installationRepositoryCache.getInstallationRepositoryById(installationRepositoryId);

  if (
    installationRepositoryRecord === undefined ||
    installationRepositoryRecord.removedAt !== null
  ) {
    throw createWorkerError(
      "github-installation-repository-unavailable",
      `GitHub installation repository '${installationRepositoryId}' is not available for ${input.unavailableRepositoryContext}.`,
    );
  }

  const installation = await installationRepository.getInstallationById(
    installationRepositoryRecord.installationId,
  );

  if (installation === undefined) {
    throw createWorkerError(
      "github-installation-missing",
      `GitHub installation '${installationRepositoryRecord.installationId}' could not be resolved for ${input.missingInstallationContext}.`,
    );
  }

  if (installation.status !== "active") {
    throw createWorkerError(
      "github-installation-inactive",
      `GitHub installation '${installation.id}' is not active for ${input.inactiveInstallationContext}.`,
    );
  }

  const accessToken = await input.gitHubSourceIntegration.createInstallationAccessToken(
    installation.externalInstallationId,
  );

  return accessToken.token;
};

export const resolveSandboxCloneAuth = async (input: {
  readonly spec: NewSandbox;
  readonly dbClient: DatabaseClient;
  readonly gitHubSourceIntegration: GitHubSourceIntegration | undefined;
}): Promise<SandboxCloneAuth | undefined> => {
  const token = await resolveInstallationAccessToken({
    authRef: input.spec.sources.sandbox.authRef,
    dbClient: input.dbClient,
    gitHubSourceIntegration: input.gitHubSourceIntegration,
    unavailableIntegrationMessage:
      "GitHub source integration is not configured for GitHub-backed sandbox launches.",
    unavailableRepositoryContext: "clone auth resolution",
    missingInstallationContext: "clone auth",
    inactiveInstallationContext: "clone auth resolution",
  });

  if (token === undefined) {
    return undefined;
  }

  return {
    type: "http-token",
    username: "x-access-token",
    token,
  };
};

export const resolveDotfilesRuntimeEnv = async (input: {
  readonly spec: NewSandbox;
  readonly dbClient: DatabaseClient;
  readonly gitHubSourceIntegration: GitHubSourceIntegration | undefined;
}): Promise<Record<string, string>> => {
  const dotfilesSource = input.spec.sources.inputs.find((source) => source.purpose === "dotfiles");

  const token = await resolveInstallationAccessToken({
    authRef: dotfilesSource?.authRef,
    dbClient: input.dbClient,
    gitHubSourceIntegration: input.gitHubSourceIntegration,
    unavailableIntegrationMessage:
      "GitHub source integration is not configured for GitHub-backed dotfiles config repos.",
    unavailableRepositoryContext: "dotfiles auth resolution",
    missingInstallationContext: "dotfiles auth",
    inactiveInstallationContext: "dotfiles auth resolution",
  });

  if (token === undefined) {
    return {};
  }

  return {
    SEALANT_DOTFILES_HTTP_USERNAME: "x-access-token",
    SEALANT_DOTFILES_HTTP_TOKEN: token,
  };
};
