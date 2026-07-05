import {
  createSandboxRequestSchema,
  createSshKeyRequestSchema,
  githubInstallationIdParamsSchema,
  githubInstallationRepositoriesQuerySchema,
  githubInstallationsQuerySchema,
  importGitHubInstallationRequestSchema,
  importGitHubInstallationResponseSchema,
  listGitHubInstallationRepositoriesResponseSchema,
  listGitHubInstallationsResponseSchema,
  listRunsQuerySchema,
  listSandboxAttemptsQuerySchema,
  listSandboxEventsQuerySchema,
  listSandboxesQuerySchema,
  listSshKeysResponseSchema,
  renameSandboxRequestSchema,
  runEventParamsSchema,
  runIdParamsSchema,
  runScrollbackQuerySchema,
  runTimelineQuerySchema,
  renameSandboxResponseSchema,
  resolvePackageQuerySchema,
  resolvePackageResponseSchema,
  sandboxIdParamsSchema,
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

const listOwnedSandboxesInputSchema = listSandboxesQuerySchema.omit({
  ownerUserId: true,
});

const sandboxAttemptsInputSchema = sandboxIdParamsSchema.extend({
  limit: listSandboxAttemptsQuerySchema.shape.limit,
});

const sandboxEventsInputSchema = sandboxIdParamsSchema.extend({
  limit: listSandboxEventsQuerySchema.shape.limit,
});

const createSandboxForSessionSchema = createSandboxRequestSchema.omit({
  ownerUserId: true,
});

const renameSandboxInputSchema = sandboxIdParamsSchema.merge(renameSandboxRequestSchema);

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

export const appRouter = router({
  auth: router({
    session: publicProcedure.query(async ({ ctx }) => {
      return ctx.session;
    }),
    protectedSession: protectedProcedure.query(async ({ ctx }) => {
      return ctx.session;
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
  sandbox: router({
    create: protectedProcedure
      .input(createSandboxForSessionSchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.coreApi.sandboxes.create({
          ...input,
          ownerUserId: ctx.session.user.id,
        });
      }),
    list: protectedProcedure
      .input(listOwnedSandboxesInputSchema.optional())
      .query(async ({ ctx, input }) => {
        /**
         * Keep a stable default limit when optional input is omitted.
         */
        return ctx.coreApi.sandboxes.list({
          limit: input?.limit ?? 25,
          ...(input?.status === undefined ? {} : { status: input.status }),
          ownerUserId: ctx.session.user.id,
        });
      }),
    byId: protectedProcedure.input(sandboxIdParamsSchema).query(async ({ ctx, input }) => {
      return ctx.coreApi.sandboxes.byId(input);
    }),
    attempts: protectedProcedure.input(sandboxAttemptsInputSchema).query(async ({ ctx, input }) => {
      return ctx.coreApi.sandboxes.attempts(input);
    }),
    events: protectedProcedure.input(sandboxEventsInputSchema).query(async ({ ctx, input }) => {
      return ctx.coreApi.sandboxes.events(input);
    }),
    rename: protectedProcedure
      .input(renameSandboxInputSchema)
      .output(renameSandboxResponseSchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.coreApi.sandboxes.rename(input);
      }),
  }),
  run: router({
    list: protectedProcedure.input(listRunsQuerySchema.optional()).query(async ({ ctx, input }) => {
      return ctx.coreApi.runs.list({
        ownerUserId: ctx.session.user.id,
        ...(input?.sandboxId === undefined ? {} : { sandboxId: input.sandboxId }),
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
});

export type AppRouter = typeof appRouter;
