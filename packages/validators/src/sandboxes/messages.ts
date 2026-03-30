import { z } from "zod";

export const workspaceBuildJobRequestedMessageKind = "workspace-build-job.requested" as const;

export const workspaceBuildJobRequestedMessageSchema = z.strictObject({
  kind: z.literal(workspaceBuildJobRequestedMessageKind),
  jobId: z.string().trim().min(1),
});

export type WorkspaceBuildJobRequestedMessage = z.infer<
  typeof workspaceBuildJobRequestedMessageSchema
>;

export const parseWorkspaceBuildJobRequestedMessage = (
  input: unknown,
): WorkspaceBuildJobRequestedMessage => {
  return workspaceBuildJobRequestedMessageSchema.parse(input);
};
