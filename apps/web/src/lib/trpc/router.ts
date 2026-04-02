import {
  createSandboxRequestSchema,
  githubInstallationIdParamsSchema,
  githubInstallationRepositoriesQuerySchema,
  githubInstallationsQuerySchema,
  importGitHubInstallationRequestSchema,
  importGitHubInstallationResponseSchema,
  listGitHubInstallationRepositoriesResponseSchema,
  listGitHubInstallationsResponseSchema,
  listSandboxAttemptsQuerySchema,
  listSandboxEventsQuerySchema,
  listSandboxesQuerySchema,
  renameSandboxRequestSchema,
  renameSandboxResponseSchema,
  resolvePackageQuerySchema,
  resolvePackageResponseSchema,
  sandboxIdParamsSchema,
  syncGitHubInstallationQuerySchema,
  syncGitHubInstallationResponseSchema,
} from "@sealant/validators";
import { z } from "zod";

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
});

export type AppRouter = typeof appRouter;
