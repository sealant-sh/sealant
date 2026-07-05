import { z } from "zod";

/*
 * Local zod mirrors of the control-plane API responses (connected accounts + profiles).
 *
 * TODO(connected-accounts): switch to `@sealant/validators` once it ships something the CLI can
 * consume at runtime — the CLI bundles to a standalone dist and the validators package currently
 * exports TS sources only (and has no profiles schemas yet). Keep in sync with
 * packages/validators/src/api/connected-accounts.ts.
 */

export const connectedAccountProviderSchema = z.enum(["claude", "codex", "github"]);
export type ConnectedAccountProvider = z.infer<typeof connectedAccountProviderSchema>;
export const CONNECTED_ACCOUNT_PROVIDERS = connectedAccountProviderSchema.options;

export const connectedAccountSummarySchema = z.object({
  connectedAccountId: z.string(),
  ownerUserId: z.string(),
  provider: connectedAccountProviderSchema,
  name: z.string(),
  kind: z.string(),
  // Tolerate statuses this CLI build does not know about yet.
  status: z.string(),
  // NON-secret display/ops data (claude token suffix, codex account id/email, github login+scopes).
  metadata: z.record(z.string(), z.unknown()),
  connectedAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
});
export type ConnectedAccountSummary = z.infer<typeof connectedAccountSummarySchema>;

export const listConnectedAccountsResponseSchema = z.object({
  items: z.array(connectedAccountSummarySchema),
});

export const profileSummarySchema = z.object({
  profileId: z.string(),
  ownerUserId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  status: z.string(),
  activeRevisionId: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProfileSummary = z.infer<typeof profileSummarySchema>;

export const listProfilesResponseSchema = z.object({
  items: z.array(profileSummarySchema),
});

export const profileCredentialBindingSchema = z.object({
  profileId: z.string(),
  provider: connectedAccountProviderSchema,
  connectedAccountId: z.string(),
  account: connectedAccountSummarySchema,
});
export type ProfileCredentialBinding = z.infer<typeof profileCredentialBindingSchema>;

export const listProfileCredentialBindingsResponseSchema = z.object({
  items: z.array(profileCredentialBindingSchema),
});
