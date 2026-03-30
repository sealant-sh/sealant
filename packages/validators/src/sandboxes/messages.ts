import { z } from "zod";

export const sandboxBuildJobRequestedMessageKind = "sandbox-build-job.requested" as const;

export const sandboxBuildJobRequestedMessageSchema = z.strictObject({
  kind: z.literal(sandboxBuildJobRequestedMessageKind),
  jobId: z.string().trim().min(1),
});

export type SandboxBuildJobRequestedMessage = z.infer<typeof sandboxBuildJobRequestedMessageSchema>;

export const parseSandboxBuildJobRequestedMessage = (
  input: unknown,
): SandboxBuildJobRequestedMessage => {
  return sandboxBuildJobRequestedMessageSchema.parse(input);
};
