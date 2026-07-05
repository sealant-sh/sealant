/**
 * Numeric protobuf enums from the telemetry log (`@sealant/runtime-protocol` sealant.v1),
 * mapped to the words the record renders. Values are stored as numbers in `telemetry_events`
 * (0 = UNSPECIFIED preserved); every map falls back to a plain "unknown"-style word rather
 * than throwing, because an unmodeled enum value is a valid stored fact.
 */

export type ExitReasonLabel =
  | "exited"
  | "signaled"
  | "timeout"
  | "cancelled"
  | "start failed"
  | "lost"
  | "unknown";

export const exitReasonLabel = (reason: number): ExitReasonLabel => {
  switch (reason) {
    case 1:
      return "exited";
    case 2:
      return "signaled";
    case 3:
      return "timeout";
    case 4:
      return "cancelled";
    case 5:
      return "start failed";
    case 6:
      return "lost";
    default:
      return "unknown";
  }
};

export type RuntimeStateLabel =
  | "starting"
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "shutting down"
  | "stopped"
  | "unknown";

export const runtimeStateLabel = (state: number): RuntimeStateLabel => {
  switch (state) {
    case 1:
      return "starting";
    case 2:
      return "healthy";
    case 3:
      return "degraded";
    case 4:
      return "unhealthy";
    case 5:
      return "shutting down";
    case 6:
      return "stopped";
    default:
      return "unknown";
  }
};

export type CaptureMethodLabel =
  | "pipe"
  | "pty"
  | "proxy"
  | "inotify"
  | "snapshot"
  | "ebpf"
  | "netlink"
  | "internal"
  | "unknown";

export const captureMethodLabel = (method: number): CaptureMethodLabel => {
  switch (method) {
    case 1:
      return "pipe";
    case 2:
      return "pty";
    case 3:
      return "proxy";
    case 4:
      return "inotify";
    case 5:
      return "snapshot";
    case 6:
      return "ebpf";
    case 7:
      return "netlink";
    case 8:
      return "internal";
    default:
      return "unknown";
  }
};

export type ConfidenceLabel = "observed" | "inferred" | "unknown";

export const confidenceLabel = (confidence: number): ConfidenceLabel => {
  switch (confidence) {
    case 1:
      return "observed";
    case 2:
      return "inferred";
    default:
      return "unknown";
  }
};

export type FileChangeKindLabel =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "metadata"
  | "unknown";

export const fileChangeKindLabel = (kind: number): FileChangeKindLabel => {
  switch (kind) {
    case 1:
      return "added";
    case 2:
      return "modified";
    case 3:
      return "deleted";
    case 4:
      return "renamed";
    case 5:
      return "metadata";
    default:
      return "unknown";
  }
};

export type NetworkSchemeLabel = "http" | "https" | "unknown";

export const networkSchemeLabel = (scheme: number): NetworkSchemeLabel => {
  switch (scheme) {
    case 1:
      return "http";
    case 2:
      return "https";
    default:
      return "unknown";
  }
};

export const STREAM_STDIN = 1;
export const STREAM_STDOUT = 2;
export const STREAM_STDERR = 3;
export const STREAM_PTY_INPUT = 4;
export const STREAM_PTY_OUTPUT = 5;
