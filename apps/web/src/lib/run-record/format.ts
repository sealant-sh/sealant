/**
 * Formatting for the recorder's voice — durations, byte counts, and run-relative time offsets.
 * Offsets are derived from the monotonic clock (microseconds), never the wall clock, so they
 * match the ordering the record was captured in.
 */

export const formatMicros = (micros: bigint): string => {
  const ms = Number(micros / 1000n);
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${rest}s`;
};

export const formatBytes = (bytes: bigint): string => {
  const value = Number(bytes);
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * `mm:ss.mmm` offset of a monotonic timestamp from the record's first event. The daemon's
 * monotonic clock ticks in NANOSECONDS (verified against `durationMicros` on processExited:
 * the deltas differ by exactly 1000).
 */
export const formatOffset = (occurredAt: string, firstOccurredAt: bigint): string => {
  let at: bigint;
  try {
    at = BigInt(occurredAt);
  } catch {
    return "--:--";
  }
  const deltaMs = at >= firstOccurredAt ? Number((at - firstOccurredAt) / 1_000_000n) : 0;
  const minutes = Math.floor(deltaMs / 60_000);
  const seconds = Math.floor((deltaMs % 60_000) / 1000);
  const millis = deltaMs % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
};

export const formatWallClock = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

/** Duration between two ISO timestamps, for the run header. */
export const formatRunDuration = (startedAt?: string, finishedAt?: string): string | undefined => {
  if (startedAt === undefined) {
    return undefined;
  }
  const start = new Date(startedAt).getTime();
  const end = finishedAt === undefined ? Date.now() : new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }
  return formatMicros(BigInt(Math.round((end - start) * 1000)));
};
