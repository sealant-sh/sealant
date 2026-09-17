import {
  WorkspaceBadRequestError,
  WorkspaceForbiddenError,
  WorkspaceInternalServerError,
  WorkspaceNotFoundError,
} from "@sealant/api-contracts";
import { GitHubInstallationRepo, GitHubInstallationRepositoryCacheRepo } from "@sealant/db";
import { parseGitHubInstallationRepositoryAuthRef } from "@sealant/source-integrations";
import type { NewWorkspace } from "@sealant/validators";
import { Effect } from "effect";

import { env } from "../../runtime-env.js";
import { gitHubWebHostOf, urlIsInstallationRepository } from "./credential-destinations.js";

const toErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback;
};

const withInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) => {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new WorkspaceInternalServerError({
          message: toErrorMessage(error, fallback),
        }),
    ),
  );
};

/**
 * Every `authRef` a client can embed in a spec is untrusted input. The only namespace allowed
 * through is `github-installation-repository:<id>` — and only after the same ownership/status
 * checks the selection resolvers perform, because the worker mints a real installation token from
 * the ref without re-checking grants. Every other value is rejected outright: a non-GitHub authRef
 * on a dotfiles input flows into `docker build --secret src=<value>` as a HOST FILE PATH
 * (buildkit-builder's ssh-key build secret), which the dotfiles repo's own bootstrap can read back
 * out of the build — a host-file exfiltration primitive. We validate rather than rebuild (the
 * `credentialRefs` mitigation) because reruns legitimately resubmit previously-minted specs
 * without their original selections.
 *
 * The ref is also bound to its destination (CORE-05): the worker sends the installation token to
 * whatever URL the source names, so that URL must be the repository the ref stands for, on the
 * GitHub host this install talks to. A grant on installation A is not a licence to send A's token
 * to another host or another repository.
 */
export const validateClientSuppliedAuthRefs = (input: {
  readonly ownerUserId: string;
  readonly spec: NewWorkspace;
}) => {
  return Effect.gen(function* () {
    const refs: Array<{
      readonly label: string;
      readonly authRef: string;
      readonly url: string;
    }> = [];
    const workspaceSource = input.spec.sources.workspace;
    if (workspaceSource.kind === "git" && workspaceSource.authRef !== undefined) {
      refs.push({
        label: "sources.workspace",
        authRef: workspaceSource.authRef,
        url: workspaceSource.url,
      });
    }
    for (const source of input.spec.sources.inputs) {
      if (source.authRef !== undefined) {
        refs.push({
          label: `sources.inputs (${source.id})`,
          authRef: source.authRef,
          url: source.url,
        });
      }
    }
    if (refs.length === 0) {
      return;
    }

    const gitHubInstallationRepository = yield* GitHubInstallationRepo;
    const gitHubInstallationRepositoryCacheRepository =
      yield* GitHubInstallationRepositoryCacheRepo;

    const webHost = gitHubWebHostOf(env.GITHUB_API_BASE_URL);
    for (const { label, authRef, url } of refs) {
      const installationRepositoryId = parseGitHubInstallationRepositoryAuthRef(authRef);
      if (installationRepositoryId === undefined) {
        return yield* new WorkspaceBadRequestError({
          message: `${label}: authRef must reference a GitHub installation repository.`,
        });
      }

      const installationRepositoryRecord = yield* withInternalError(
        gitHubInstallationRepositoryCacheRepository.getInstallationRepositoryById(
          installationRepositoryId,
        ),
        "Failed to load GitHub installation repository.",
      );

      if (
        installationRepositoryRecord === undefined ||
        installationRepositoryRecord.removedAt !== null
      ) {
        return yield* new WorkspaceNotFoundError({
          message: `${label}: GitHub installation repository not found: ${installationRepositoryId}`,
        });
      }

      if (
        !urlIsInstallationRepository({
          url,
          webHost,
          owner: installationRepositoryRecord.owner,
          name: installationRepositoryRecord.name,
        })
      ) {
        // Says nothing about which repository the ref stands for: the caller may not know it.
        return yield* new WorkspaceForbiddenError({
          message: `${label}: the source URL is not the repository this authRef was issued for (expected https://${webHost}/<owner>/<name>).`,
        });
      }

      const installation = yield* withInternalError(
        gitHubInstallationRepository.getInstallationById(
          installationRepositoryRecord.installationId,
        ),
        "Failed to load GitHub installation.",
      );

      if (installation === undefined || installation.status !== "active") {
        return yield* new WorkspaceForbiddenError({
          message: `${label}: GitHub installation ${installationRepositoryRecord.installationId} is not active.`,
        });
      }

      const hasGrant = yield* withInternalError(
        gitHubInstallationRepository.userHasInstallationGrant({
          installationId: installation.id,
          userId: input.ownerUserId,
        }),
        "Failed to verify GitHub installation access.",
      );

      if (!hasGrant) {
        return yield* new WorkspaceForbiddenError({
          message: `${label}: user ${input.ownerUserId} does not have access to GitHub installation ${installation.id}.`,
        });
      }
    }
  });
};
