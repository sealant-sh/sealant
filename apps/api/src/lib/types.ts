export interface SandboxBuildJobPublisher {
  publishRequested(input: { jobId: string }): Promise<void>;
}
