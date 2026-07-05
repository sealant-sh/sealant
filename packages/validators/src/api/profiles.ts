import { z } from "zod";

import {
  connectedAccountProviderSchema,
  connectedAccountSummarySchema,
} from "./connected-accounts.js";

/*
Browser-safe zod mirrors of the profiles core API contract (packages/api-contracts). Used by the
web tRPC router + profile "agents" UI. Bindings embed connected-account summaries only — never
secret material. Note: the connect-time `setProfileCredentialBindingRequestSchema` (with
`profileId` in the body) lives in ./connected-accounts.js; the schema here mirrors the HTTP body
of `PUT /v1/profiles/:profileId/credential-bindings`, where the profile id travels in the URL.
*/

export const profileStatusSchema = z.enum(["active", "archived"]);

export const profileSummarySchema = z.object({
  profileId: z.string(),
  ownerUserId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: profileStatusSchema,
  activeRevisionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listProfilesResponseSchema = z.object({
  items: z.array(profileSummarySchema),
});

export const profileCredentialBindingWithAccountSchema = z.object({
  profileId: z.string(),
  provider: connectedAccountProviderSchema,
  connectedAccountId: z.string(),
  account: connectedAccountSummarySchema,
});

export const listProfileCredentialBindingsResponseSchema = z.object({
  items: z.array(profileCredentialBindingWithAccountSchema),
});

export const setProfileCredentialBindingBodySchema = z.object({
  ownerUserId: z.string().trim().min(1),
  provider: connectedAccountProviderSchema,
  // null clears the binding for that provider.
  connectedAccountId: z.string().trim().min(1).nullable(),
});

export type ProfileStatus = z.infer<typeof profileStatusSchema>;
export type ProfileSummary = z.infer<typeof profileSummarySchema>;
export type ListProfilesResponse = z.infer<typeof listProfilesResponseSchema>;
export type ProfileCredentialBindingWithAccount = z.infer<
  typeof profileCredentialBindingWithAccountSchema
>;
export type ListProfileCredentialBindingsResponse = z.infer<
  typeof listProfileCredentialBindingsResponseSchema
>;
export type SetProfileCredentialBindingBody = z.infer<typeof setProfileCredentialBindingBodySchema>;
