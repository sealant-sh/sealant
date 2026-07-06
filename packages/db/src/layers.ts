import { Layer } from "effect";

import { ConnectedAccountRepoLive } from "./repositories/connected-accounts.js";
import { GitHubInstallationRepositoryCacheRepoLive } from "./repositories/github-installation-repositories.js";
import { GitHubInstallationRepoLive } from "./repositories/github-installations.js";
import { GitHubWebhookDeliveryRepoLive } from "./repositories/github-webhook-deliveries.js";
import { PackageResolutionCacheRepoLive } from "./repositories/package-resolution-cache.js";
import { ProfileRepoLive } from "./repositories/profiles.js";
import { RepositoryProfileRepoLive } from "./repositories/repository-profiles.js";
import { RunRepoLive } from "./repositories/runs.js";
import { SshKeyRepoLive } from "./repositories/ssh-keys.js";
import { UserRepoLive } from "./repositories/users.js";
import { WorkspaceAttemptRepoLive } from "./repositories/workspace-attempts.js";
import { WorkspaceBuildJobRepoLive } from "./repositories/workspace-build-jobs.js";
import { WorkspaceRuntimeInstanceRepoLive } from "./repositories/workspace-runtime-instances.js";
import { WorkspaceRepoLive } from "./repositories/workspaces.js";

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
  WorkspaceRepoLive,
  WorkspaceAttemptRepoLive,
  WorkspaceRuntimeInstanceRepoLive,
  WorkspaceBuildJobRepoLive,
  RunRepoLive,
  ProfileRepoLive,
  SshKeyRepoLive,
  UserRepoLive,
  ConnectedAccountRepoLive,
);
