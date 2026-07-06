import { z } from "zod";

export const indexResponseSchema = z.object({
  name: z.string(),
  version: z.string(),
  docsPath: z.string(),
  openApiPath: z.string(),
});

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export const setupStateResponseSchema = z.object({
  // True while nobody can sign in (zero better-auth accounts); drives the first-run wizard. The
  // seeded SDK owner (usr_local) has no credentials and does not count.
  needsSetup: z.boolean(),
  // Null when the API has no WORKSPACE_SSH_GATEWAY_HOST configured. Defaults (22 / "ws") are
  // applied server-side so clients never hardcode them.
  sshGateway: z
    .object({
      host: z.string().min(1),
      port: z.number().int(),
      usernamePrefix: z.string().min(1),
    })
    .nullable(),
});

export type SetupStateResponse = z.infer<typeof setupStateResponseSchema>;
