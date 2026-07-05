import {
  connectedAccountIdParamsSchema,
  connectedAccountSummarySchema,
  createConnectedAccountRequestSchema,
  createSandboxRequestSchema,
  createSshKeyRequestSchema,
  githubInstallationIdParamsSchema,
  githubInstallationRepositoriesQuerySchema,
  githubInstallationsQuerySchema,
  importGitHubInstallationRequestSchema,
  importGitHubInstallationResponseSchema,
  listGitHubInstallationRepositoriesResponseSchema,
  listGitHubInstallationsResponseSchema,
  listSandboxAttemptsQuerySchema,
  listSandboxEventsQuerySchema,
  listConnectedAccountsResponseSchema,
  listProfileCredentialBindingsResponseSchema,
  listProfilesResponseSchema,
  listSandboxesQuerySchema,
  listSshKeysResponseSchema,
  renameSandboxRequestSchema,
  renameSandboxResponseSchema,
  resolvePackageQuerySchema,
  resolvePackageResponseSchema,
  sandboxIdParamsSchema,
  setProfileCredentialBindingRequestSchema,
  sshKeyIdParamsSchema,
  sshKeySummarySchema,
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

const createSshKeyForSessionSchema = createSshKeyRequestSchema.omit({
  ownerUserId: true,
});

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
