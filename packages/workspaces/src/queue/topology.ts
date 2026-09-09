import { createJobQueueService, defineJobQueue } from "@sealant/jobs";

/**
 * Primary queue used for workspace build job orchestration.
 */
export const workspaceBuildQueueName = "workspace-image-builds";

/**
 * Dead-letter queue for workspace build job failures.
 */
export const workspaceBuildDeadLetterQueueName = "workspace-image-builds.dlq";

/**
 * Canonical queue definition used by all workspace build queue producers/consumers. An image build
 * (clone + docker build + launch) can legitimately take a long time on a cold cache, so the active
 * window is generous; the build-job lease + reaper own the "worker died mid-build" recovery.
 */
export const workspaceBuildQueue = defineJobQueue(workspaceBuildQueueName, {
  activeTimeoutSeconds: 2 * 60 * 60,
});

/**
 * Ensures the workspace build queue (and its dead-letter queue) exists.
 */
export const ensureWorkspaceBuildQueueTopology = async (databaseUrl: string) => {
  const jobs = createJobQueueService(databaseUrl);

  await jobs.ensureQueue(workspaceBuildQueue);
};
