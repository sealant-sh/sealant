/**
 * The trace a job carries from the process that sent it to the one that handles it. pg-boss has no
 * message headers, so the sender's W3C context rides in the job's data under one reserved key,
 * which the consumer takes out before the message reaches its parser.
 */
import type { TraceCarrier } from "@sealant/observability";

/** The reserved key in a job's data. No domain message names a field this. */
export const JOB_TRACE_KEY = "_trace";

/** `message` with `trace` under the reserved key, as it is sent. */
export const withJobTrace = (message: object, trace: TraceCarrier | undefined): object =>
  trace === undefined ? message : { ...message, [JOB_TRACE_KEY]: trace };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A delivery's data split into the message its parser reads and the trace it carried, if it
 * carried a well-formed one. Data without the key is returned as it is.
 */
export const takeJobTrace = (
  data: unknown,
): { readonly message: unknown; readonly trace: TraceCarrier | undefined } => {
  if (!isRecord(data) || !(JOB_TRACE_KEY in data)) return { message: data, trace: undefined };
  const { [JOB_TRACE_KEY]: carried, ...message } = data;
  if (!isRecord(carried) || typeof carried["traceparent"] !== "string") {
    return { message, trace: undefined };
  }
  const tracestate = carried["tracestate"];
  return {
    message,
    trace: {
      traceparent: carried["traceparent"],
      ...(typeof tracestate === "string" ? { tracestate } : {}),
    },
  };
};
