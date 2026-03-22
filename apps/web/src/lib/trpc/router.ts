import { z } from "zod";

import {
  getManifest,
  getRegistry,
  getRepositoryTags,
  listRegistries,
  listRepositories,
} from "@/lib/api/registry-service";

import {
  resolvePackageQuerySchema,
  resolvePackageResponseSchema,
} from "../../../../api/src/routes/packages/packages.schemas";
import {
  createSandboxRequestSchema,
  listSandboxAttemptsQuerySchema,
  listSandboxEventsQuerySchema,
  listSandboxesQuerySchema,
  sandboxIdParamsSchema,
} from "../../../../api/src/routes/sandboxes/sandboxes.schemas";
import { protectedProcedure, publicProcedure, router } from "./trpc";

const registryIdSchema = z.object({
  registryId: z.string().trim().min(1),
});

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
        const query = listOwnedSandboxesInputSchema.parse(input ?? {});

        return ctx.coreApi.sandboxes.list({
          ...query,
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
  }),
});

export type AppRouter = typeof appRouter;
