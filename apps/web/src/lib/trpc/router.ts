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
});

export type AppRouter = typeof appRouter;
