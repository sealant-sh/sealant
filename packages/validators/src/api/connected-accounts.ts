import { z } from "zod";

/*
Browser-safe zod mirrors of the connected-accounts core API contract (packages/api-contracts).
Used by the web tRPC router + settings UI. Secret material only ever flows INTO the API via
`createConnectedAccountRequestSchema.secret`; no response schema ever includes it.
*/

export const connectedAccountProviderSchema = z.enum(["claude", "codex", "github"]);

export const connectedAccountStatusSchema = z.enum(["active", "invalid", "archived"]);

export const connectedAccountSummarySchema = z.object({
  connectedAccountId: z.string(),
  ownerUserId: z.string(),
  provider: connectedAccountProviderSchema,
  name: z.string(),
  kind: z.string(),
  status: connectedAccountStatusSchema,
  // NON-secret display/ops data (claude token suffix, codex account id/email, github login+scopes).
  metadata: z.record(z.string(), z.unknown()),
  connectedAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
});

export const createConnectedAccountRequestSchema = z.object({
  // Same trust model as ssh-keys: the internal API trusts the caller-supplied owner; the web
  // server injects the session user id.
  ownerUserId: z.string().trim().min(1),
  provider: connectedAccountProviderSchema,
  name: z.string().trim().min(1).max(120).optional(),
  // Provider-shaped plaintext: claude setup-token / verbatim codex auth.json contents / github
  // token. Encrypted server-side; never stored or echoed back as-is.
  secret: z.string().min(1),
});

export const connectedAccountIdParamsSchema = z.object({
  connectedAccountId: z.string().trim().min(1),
});

export const listConnectedAccountsResponseSchema = z.object({
  items: z.array(connectedAccountSummarySchema),
});

export const profileCredentialBindingSchema = z.object({
  profileId: z.string(),
  provider: connectedAccountProviderSchema,
  connectedAccountId: z.string(),
});

export const setProfileCredentialBindingRequestSchema = z.object({
  ownerUserId: z.string().trim().min(1),
  profileId: z.string().trim().min(1),
  provider: connectedAccountProviderSchema,
  // null clears the binding for that provider.
  connectedAccountId: z.string().trim().min(1).nullable(),
});

export type ConnectedAccountProvider = z.infer<typeof connectedAccountProviderSchema>;
export type ConnectedAccountStatus = z.infer<typeof connectedAccountStatusSchema>;
export type ConnectedAccountSummary = z.infer<typeof connectedAccountSummarySchema>;
export type CreateConnectedAccountRequest = z.infer<typeof createConnectedAccountRequestSchema>;
export type ListConnectedAccountsResponse = z.infer<typeof listConnectedAccountsResponseSchema>;
export type ProfileCredentialBinding = z.infer<typeof profileCredentialBindingSchema>;
export type SetProfileCredentialBindingRequest = z.infer<
  typeof setProfileCredentialBindingRequestSchema
>;
