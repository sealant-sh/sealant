import type { TraceCarrier } from "@sealant/observability";

export interface WorkspaceBuildJobPublisher {
  /** `trace`: the request's trace, which the build continues (`currentTraceCarrier`). */
  publishRequested(input: { jobId: string; trace?: TraceCarrier | undefined }): Promise<void>;
}
