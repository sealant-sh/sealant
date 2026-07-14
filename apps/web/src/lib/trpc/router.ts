import {
  connectedAccountIdParamsSchema,
  connectedAccountSummarySchema,
  createConnectedAccountRequestSchema,
  createWorkspaceRequestSchema,
  createSshKeyRequestSchema,
  githubInstallationIdParamsSchema,
  githubInstallationRepositoriesQuerySchema,
  githubInstallationsQuerySchema,
  importGitHubInstallationRequestSchema,
  importGitHubInstallationResponseSchema,
  listGitHubInstallationRepositoriesResponseSchema,
  listGitHubInstallationsResponseSchema,
  listRunsQuerySchema,
  listWorkspaceAttemptsQuerySchema,
  listWorkspaceEventsQuerySchema,
  listConnectedAccountsResponseSchema,
  listProfileCredentialBindingsResponseSchema,
  listProfilesResponseSchema,
  listWorkspacesQuerySchema,
  listSshKeysResponseSchema,
  renameWorkspaceRequestSchema,
  runEventParamsSchema,
  runIdParamsSchema,
  runScrollbackQuerySchema,
  runTimelineQuerySchema,
  renameWorkspaceResponseSchema,
  resolvePackageQuerySchema,
  resolvePackageResponseSchema,
  workspaceIdParamsSchema,
  setProfileCredentialBindingRequestSchema,
  setupStateResponseSchema,
  sshKeyIdParamsSchema,
  sshKeySummarySchema,
  syncGitHubInstallationQuerySchema,
  syncGitHubInstallationResponseSchema,
} from "@sealant/validators";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { CoreApiHttpError, type CoreApiClient } from "@/lib/api/core-api-client";
import {
  getManifest,
  getRegistry,
  getRepositoryTags,
  listRegistries,
  listRepositories,
} from "@/lib/api/registry-service";

import { protectedProcedure, publicProcedure, router } from "./trpc";

const registryIdSchema = z.object({
  registryId: z.string().trim().min(1),
});

const listGitHubInstallationsForSessionSchema = githubInstallationsQuerySchema.omit({
  userId: true,
});

const listGitHubInstallationRepositoriesForSessionSchema = githubInstallationIdParamsSchema.merge(
  githubInstallationRepositoriesQuerySchema.omit({ userId: true }),
);

const importGitHubInstallationForSessionSchema = importGitHubInstallationRequestSchema.omit({
  userId: true,
});

const syncGitHubInstallationForSessionSchema = githubInstallationIdParamsSchema.merge(
  syncGitHubInstallationQuerySchema.omit({ userId: true }),
);

const listOwnedWorkspacesInputSchema = listWorkspacesQuerySchema.omit({
  ownerUserId: true,
});

const workspaceAttemptsInputSchema = workspaceIdParamsSchema.extend({
  limit: listWorkspaceAttemptsQuerySchema.shape.limit,
});

const workspaceEventsInputSchema = workspaceIdParamsSchema.extend({
  limit: listWorkspaceEventsQuerySchema.shape.limit,
});

const createWorkspaceForSessionSchema = createWorkspaceRequestSchema.omit({
  ownerUserId: true,
});

const renameWorkspaceInputSchema = workspaceIdParamsSchema.merge(renameWorkspaceRequestSchema);

const createSshKeyForSessionSchema = createSshKeyRequestSchema.omit({
  ownerUserId: true,
});

const runTimelineInputSchema = runIdParamsSchema.extend(runTimelineQuerySchema.shape);

const runScrollbackInputSchema = runIdParamsSchema.extend(runScrollbackQuerySchema.shape);

/**
 * The core API is an unauthenticated internal boundary (it trusts its callers), so per-user
 * scoping is enforced HERE: every run read loads the run and matches its owner against the
 * session before serving record data. A foreign or missing run is NOT_FOUND either way, so run
 * ids don't leak existence across users.
 */
const requireOwnedRun = async (coreApi: CoreApiClient, userId: string, runId: string) => {
  let run;
  try {
    run = await coreApi.runs.byId({ runId });
  } catch (error) {
    if (error instanceof CoreApiHttpError && error.status === 404) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Run not found: ${runId}` });
    }
    throw error;
  }
  if (run.ownerUserId !== userId) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Run not found: ${runId}` });
  }
  return run;
};

const connectAccountForSessionSchema = createConnectedAccountRequestSchema.omit({
  ownerUserId: true,
});

const setProfileCredentialBindingForSessionSchema = setProfileCredentialBindingRequestSchema.omit({
  ownerUserId: true,
});

const profileIdInputSchema = z.object({
  profileId: z.string().trim().min(1),
});

export const appRouter = router({
  auth: router({
    session: publicProcedure.query(async ({ ctx }) => {
      return ctx.session;
    }),
    protectedSession: protectedProcedure.query(async ({ ctx }) => {
      return ctx.session;
    }),
  }),
  setup: router({
    // Public: pre-auth route gating decides between /login and the first-run /setup wizard.
    state: publicProcedure.output(setupStateResponseSchema).query(async ({ ctx }) => {
      return ctx.coreApi.system.setupState();
    }),
  }),
  registry: router({
    list: protectedProcedure.query(async () => {
      return listRegistries();
    }),
    byId: protectedProcedure.input(registryIdSchema).query(async ({ input }) => {
      return getRegistry(input.registryId);
    }),
    repositories: protectedProcedure.input(registryIdSchema).query(async ({ input }) => {
      return listRepositories(input.registryId);
    }),
    tags: protectedProcedure
      .input(
        z.object({
          registryId: z.string().trim().min(1),
          repository: z.string().trim().min(1),
        }),
      )
      .query(async ({ input }) => {
        return getRepositoryTags(input.registryId, input.repository);
      }),
    manifest: protectedProcedure
      .input(
        z.object({
          registryId: z.string().trim().min(1),
          repository: z.string().trim().min(1),
          reference: z.string().trim().min(1),
        }),
      )
      .query(async ({ input }) => {
        return getManifest(input.registryId, input.repository, input.reference);
      }),
  }),
  package: router({
    resolve: protectedProcedure
      .input(resolvePackageQuerySchema)
      .output(resolvePackageResponseSchema)
      .query(async ({ ctx, input }) => {
        return ctx.coreApi.packages.resolve(input);
      }),
  }),
  github: router({
    installations: protectedProcedure
      .input(listGitHubInstallationsForSessionSchema.optional())
      .output(listGitHubInstallationsResponseSchema)
      .query(async ({ ctx }) => {
        return ctx.coreApi.github.installations({
          userId: ctx.session.user.id,
        });
      }),
    installationRepositories: protectedProcedure
      .input(listGitHubInstallationRepositoriesForSessionSchema)
      .output(listGitHubInstallationRepositoriesResponseSchema)
      .query(async ({ ctx, input }) => {
        return ctx.coreApi.github.installationRepositories({
          installationId: input.installationId,
          userId: ctx.session.user.id,
          ...(input.search === undefined ? {} : { search: input.search }),
        });
      }),
    importInstallation: protectedProcedure
      .input(importGitHubInstallationForSessionSchema)
      .output(importGitHubInstallationResponseSchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.coreApi.github.importInstallation({
          externalInstallationId: input.externalInstallationId,
          userId: ctx.session.user.id,
        });
      }),
    syncInstallation: protectedProcedure
      .input(syncGitHubInstallationForSessionSchema)
      .output(syncGitHubInstallationResponseSchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.coreApi.github.syncInstallation({
          installationId: input.installationId,
          userId: ctx.session.user.id,
        });
      }),
  }),
  workspace: router({
    create: protectedProcedure
      .input(createWorkspaceForSessionSchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.coreApi.workspaces.create({
          ...input,
          ownerUserId: ctx.session.user.id,
        });
      }),
    list: protectedProcedure
      .input(listOwnedWorkspacesInputSchema.optional())
      .query(async ({ ctx, input }) => {
        /**
         * Keep a stable default limit when optional input is omitted.
         */
        return ctx.coreApi.workspaces.list({
          limit: input?.limit ?? 25,
          ...(input?.status === undefined ? {} : { status: input.status }),
          ownerUserId: ctx.session.user.id,
        });
      }),
    byId: protectedProcedure.input(workspaceIdParamsSchema).query(async ({ ctx, input }) => {
      return ctx.coreApi.workspaces.byId(input);
    }),
    attempts: protectedProcedure
      .input(workspaceAttemptsInputSchema)
      .query(async ({ ctx, input }) => {
        return ctx.coreApi.workspaces.attempts(input);
      }),
    events: protectedProcedure.input(workspaceEventsInputSchema).query(async ({ ctx, input }) => {
      return ctx.coreApi.workspaces.events(input);
    }),
    rename: protectedProcedure
      .input(renameWorkspaceInputSchema)
      .output(renameWorkspaceResponseSchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.coreApi.workspaces.rename(input);
      }),
    // Owner scoping rides in the payload: the core API 404s on a mismatch (uniform not-found).
    stop: protectedProcedure.input(workspaceIdParamsSchema).mutation(async ({ ctx, input }) => {
      return ctx.coreApi.workspaces.stop({
        workspaceId: input.workspaceId,
        ownerUserId: ctx.session.user.id,
      });
    }),
    restart: protectedProcedure.input(workspaceIdParamsSchema).mutation(async ({ ctx, input }) => {
      return ctx.coreApi.workspaces.restart({
        workspaceId: input.workspaceId,
        ownerUserId: ctx.session.user.id,
      });
    }),
  }),
  run: router({
    list: protectedProcedure.input(listRunsQuerySchema.optional()).query(async ({ ctx, input }) => {
      return ctx.coreApi.runs.list({
        ownerUserId: ctx.session.user.id,
        ...(input?.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input?.status === undefined ? {} : { status: input.status }),
        limit: input?.limit ?? 25,
      });
    }),
    byId: protectedProcedure.input(runIdParamsSchema).query(async ({ ctx, input }) => {
      return requireOwnedRun(ctx.coreApi, ctx.session.user.id, input.runId);
    }),
    timeline: protectedProcedure.input(runTimelineInputSchema).query(async ({ ctx, input }) => {
      await requireOwnedRun(ctx.coreApi, ctx.session.user.id, input.runId);
      return ctx.coreApi.runs.timeline(input);
    }),
    event: protectedProcedure.input(runEventParamsSchema).query(async ({ ctx, input }) => {
      await requireOwnedRun(ctx.coreApi, ctx.session.user.id, input.runId);
      return ctx.coreApi.runs.event(input);
    }),
    scrollback: protectedProcedure.input(runScrollbackInputSchema).query(async ({ ctx, input }) => {
      await requireOwnedRun(ctx.coreApi, ctx.session.user.id, input.runId);
      return ctx.coreApi.runs.scrollback(input);
    }),
    loss: protectedProcedure.input(runIdParamsSchema).query(async ({ ctx, input }) => {
      await requireOwnedRun(ctx.coreApi, ctx.session.user.id, input.runId);
      return ctx.coreApi.runs.loss(input);
    }),
    changes: protectedProcedure.input(runIdParamsSchema).query(async ({ ctx, input }) => {
      await requireOwnedRun(ctx.coreApi, ctx.session.user.id, input.runId);
      return ctx.coreApi.runs.changes(input);
    }),
  }),
  sshKey: router({
    list: protectedProcedure.output(listSshKeysResponseSchema).query(async ({ ctx }) => {
      return ctx.coreApi.sshKeys.list({ ownerUserId: ctx.session.user.id });
    }),
    add: protectedProcedure
      .input(createSshKeyForSessionSchema)
      .output(sshKeySummarySchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.coreApi.sshKeys.create({
          ...input,
          ownerUserId: ctx.session.user.id,
        });
      }),
    remove: protectedProcedure
      .input(sshKeyIdParamsSchema)
      .output(sshKeySummarySchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.coreApi.sshKeys.archive({
          sshKeyId: input.sshKeyId,
          ownerUserId: ctx.session.user.id,
        });
      }),
  }),
  connectedAccounts: router({
    list: protectedProcedure.output(listConnectedAccountsResponseSchema).query(async ({ ctx }) => {
      return ctx.coreApi.connectedAccounts.list({ ownerUserId: ctx.session.user.id });
    }),
    connect: protectedProcedure
      .input(connectAccountForSessionSchema)
      .output(connectedAccountSummarySchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.coreApi.connectedAccounts.create({
          ...input,
          ownerUserId: ctx.session.user.id,
        });
      }),
    disconnect: protectedProcedure
      .input(connectedAccountIdParamsSchema)
      .output(connectedAccountSummarySchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.coreApi.connectedAccounts.archive({
          connectedAccountId: input.connectedAccountId,
          ownerUserId: ctx.session.user.id,
        });
      }),
    profilesList: protectedProcedure.output(listProfilesResponseSchema).query(async ({ ctx }) => {
      return ctx.coreApi.profiles.list({ ownerUserId: ctx.session.user.id });
    }),
    profileBindings: protectedProcedure
      .input(profileIdInputSchema)
      .output(listProfileCredentialBindingsResponseSchema)
      .query(async ({ ctx, input }) => {
        return ctx.coreApi.profiles.listCredentialBindings({
          profileId: input.profileId,
          ownerUserId: ctx.session.user.id,
        });
      }),
    setProfileBinding: protectedProcedure
      .input(setProfileCredentialBindingForSessionSchema)
      .output(listProfileCredentialBindingsResponseSchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.coreApi.profiles.setCredentialBinding({
          profileId: input.profileId,
          provider: input.provider,
          connectedAccountId: input.connectedAccountId,
          ownerUserId: ctx.session.user.id,
        });
      }),
  }),
});

export type AppRouter = typeof appRouter;
