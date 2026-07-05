import { Layer } from "effect";

import { GitHubInstallationRepositoryCacheRepoLive } from "./repositories/github-installation-repositories.js";
import { GitHubInstallationRepoLive } from "./repositories/github-installations.js";
import { GitHubWebhookDeliveryRepoLive } from "./repositories/github-webhook-deliveries.js";
import { PackageResolutionCacheRepoLive } from "./repositories/package-resolution-cache.js";
import { ProfileRepoLive } from "./repositories/profiles.js";
import { RepositoryProfileRepoLive } from "./repositories/repository-profiles.js";
import { RunRepoLive } from "./repositories/runs.js";
import { SandboxAttemptRepoLive } from "./repositories/sandbox-attempts.js";
import { SandboxBuildJobRepoLive } from "./repositories/sandbox-build-jobs.js";
import { SandboxRuntimeInstanceRepoLive } from "./repositories/sandbox-runtime-instances.js";
import { SandboxRepoLive } from "./repositories/sandboxes.js";
import { SshKeyRepoLive } from "./repositories/ssh-keys.js";

/**
 * GitHub-focused data access layer.
 *
 * This layer intentionally does not construct a SQL client on its own.
 * It expects `SealantDB` to be provided by the app boundary, where runtime-specific
 * concerns such as Postgres URL, pooling knobs, and TLS options are known.
 */
export const GitHubDataAccessLive = Layer.mergeAll(
  GitHubInstallationRepoLive,
  GitHubInstallationRepositoryCacheRepoLive,
  GitHubWebhookDeliveryRepoLive,
  RepositoryProfileRepoLive,
);

/**
 * Full control-plane data access layer.
 *
 * This is a convenience "sane default" for services that need most repository services.
 * As with `GitHubDataAccessLive`, the app must still provide `SealantDB`.
 */
export const ControlPlaneDataAccessLive = Layer.mergeAll(
  GitHubInstallationRepoLive,
  GitHubInstallationRepositoryCacheRepoLive,
  GitHubWebhookDeliveryRepoLive,
  RepositoryProfileRepoLive,
  PackageResolutionCacheRepoLive,
  SandboxRepoLive,
  SandboxAttemptRepoLive,
  SandboxRuntimeInstanceRepoLive,
  SandboxBuildJobRepoLive,
  RunRepoLive,
  ProfileRepoLive,
  SshKeyRepoLive,
);
