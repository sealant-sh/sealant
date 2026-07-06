export interface WorkspaceBuildJobPublisher {
  publishRequested(input: { jobId: string }): Promise<void>;
}
