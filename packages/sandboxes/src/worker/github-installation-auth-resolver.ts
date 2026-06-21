import {
  GitHubInstallationRepo,
  GitHubInstallationRepositoryCacheRepo,
} from "@sealant/db";
import {
  parseGitHubInstallationRepositoryAuthRef,
  type GitHubSourceIntegration,
} from "@sealant/source-integrations";
import type { NewSandbox } from "@sealant/validators";
import { Effect } from "effect";

import type { SandboxCloneAuth } from "../runtime/index.js";
import {
  sandboxBuildJobProcessingError,
  toSandboxBuildJobProcessingError,
} from "./errors.js";

interface ResolveInstallationAccessTokenInput {
  readonly authRef: string | undefined;
  readonly gitHubSourceIntegration: GitHubSourceIntegration | undefined;
  readonly unavailableIntegrationMessage: string;
  readonly unavailableRepositoryContext: string;
  readonly missingInstallationContext: string;
  readonly inactiveInstallationContext: string;
}

/**
 * Resolve a short-lived GitHub installation access token for an installation-repository auth ref.
 *
 * Returns `undefined` when the auth ref does not reference a GitHub installation repository;
 * fails with a {@link SandboxBuildJobProcessingError} when the integration is unavailable or the
 * installation cannot be resolved. The GitHub repositories are taken from context, so a single
 * data-access layer is provided once at the worker boundary.
 */
const resolveInstallationAccessToken = Effect.fn("resolveInstallationAccessToken")(
  function* (input: ResolveInstallationAccessTokenInput) {
    const installationRepositoryId = parseGitHubInstallationRepositoryAuthRef(input.authRef);

    if (installationRepositoryId === undefined) {
      return undefined;
    }

    if (
      input.gitHubSourceIntegration === undefined ||
      !input.gitHubSourceIntegration.isConfigured()
    ) {
      return yield* sandboxBuildJobProcessingError({
        errorCode: "github-integration-unavailable",
        message: input.unavailableIntegrationMessage,
      });
    }

    const installationRepositories = yield* GitHubInstallationRepositoryCacheRepo;
    const installations = yield* GitHubInstallationRepo;

    const installationRepositoryRecord = yield* installationRepositories
      .getInstallationRepositoryById(installationRepositoryId)
      .pipe(Effect.mapError(toSandboxBuildJobProcessingError));

    if (
      installationRepositoryRecord === undefined ||
      installationRepositoryRecord.removedAt !== null
    ) {
      return yield* sandboxBuildJobProcessingError({
        errorCode: "github-installation-repository-unavailable",
        message: `GitHub installation repository '${installationRepositoryId}' is not available for ${input.unavailableRepositoryContext}.`,
      });
    }

    const installation = yield* installations
      .getInstallationById(installationRepositoryRecord.installationId)
      .pipe(Effect.mapError(toSandboxBuildJobProcessingError));

    if (installation === undefined) {
      return yield* sandboxBuildJobProcessingError({
        errorCode: "github-installation-missing",
        message: `GitHub installation '${installationRepositoryRecord.installationId}' could not be resolved for ${input.missingInstallationContext}.`,
      });
    }

    if (installation.status !== "active") {
      return yield* sandboxBuildJobProcessingError({
        errorCode: "github-installation-inactive",
        message: `GitHub installation '${installation.id}' is not active for ${input.inactiveInstallationContext}.`,
      });
    }

    const accessToken = yield* input.gitHubSourceIntegration
      .createInstallationAccessToken(installation.externalInstallationId)
      .pipe(Effect.mapError(toSandboxBuildJobProcessingError));

    return accessToken.token;
  },
);

export interface ResolveSandboxAuthInput {
  readonly spec: NewSandbox;
  readonly gitHubSourceIntegration: GitHubSourceIntegration | undefined;
}

/**
 * Resolve clone auth for the sandbox source repository, minting a GitHub installation token when
 * the source is GitHub-backed. Yields `undefined` when no installation auth is required.
 */
export const resolveSandboxCloneAuth = Effect.fn("resolveSandboxCloneAuth")(function* (
  input: ResolveSandboxAuthInput,
) {
  const token = yield* resolveInstallationAccessToken({
    authRef: input.spec.sources.sandbox.authRef,
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

  const auth: SandboxCloneAuth = {
    type: "http-token",
    username: "x-access-token",
    token,
  };

  return auth;
});

/**
 * Resolve the runtime environment variables that inject a GitHub installation token for
 * dotfiles config repos applied at runtime. Returns an empty record when no token is required.
 */
export const resolveDotfilesRuntimeEnv = Effect.fn("resolveDotfilesRuntimeEnv")(function* (
  input: ResolveSandboxAuthInput,
) {
  const dotfilesSource = input.spec.sources.inputs.find((source) => source.purpose === "dotfiles");

  const token = yield* resolveInstallationAccessToken({
    authRef: dotfilesSource?.authRef,
    gitHubSourceIntegration: input.gitHubSourceIntegration,
    unavailableIntegrationMessage:
      "GitHub source integration is not configured for GitHub-backed dotfiles config repos.",
    unavailableRepositoryContext: "dotfiles auth resolution",
    missingInstallationContext: "dotfiles auth",
    inactiveInstallationContext: "dotfiles auth resolution",
  });

  if (token === undefined) {
    return {} as Record<string, string>;
  }

  return {
    SEALANT_DOTFILES_HTTP_USERNAME: "x-access-token",
    SEALANT_DOTFILES_HTTP_TOKEN: token,
  } as Record<string, string>;
});
