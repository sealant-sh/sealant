import { z } from "zod";

/*
Browser-safe zod mirrors of the ssh-keys core API contract (packages/api-contracts). Used by the
web tRPC router + settings UI. Key parsing/fingerprinting itself lives in the Node-only subpath
`@sealant/validators/ssh-public-key` — the API is the authoritative parser; these schemas only
shape requests/responses.
*/

export const createSshKeyRequestSchema = z.object({
  ownerUserId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  publicKey: z.string().trim().min(1).max(16_384),
});

export const sshKeyIdParamsSchema = z.object({
  sshKeyId: z.string().trim().min(1),
});

export const sshKeySummarySchema = z.object({
  sshKeyId: z.string(),
  ownerUserId: z.string(),
  name: z.string(),
  algorithm: z.string(),
  fingerprint: z.string(),
  createdAt: z.string(),
});

export const listSshKeysResponseSchema = z.object({
  items: z.array(sshKeySummarySchema),
});

export type SshKeySummary = z.infer<typeof sshKeySummarySchema>;
export type ListSshKeysResponse = z.infer<typeof listSshKeysResponseSchema>;
