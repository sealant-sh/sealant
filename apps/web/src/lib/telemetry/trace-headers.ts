/**
 * The trace context a browser request carries, cut down to what the web server may pass on to
 * sealant's API: a well-formed W3C `traceparent` with its `tracestate`, Sentry's `sentry-trace` (the
 * API's fallback carrier), and only the `sentry-*` members of `baggage`. Anything malformed is
 * dropped rather than forwarded, and nothing else in the request is touched.
 */
export type TraceHeaders = Readonly<Record<string, string>>;

const TRACEPARENT = /^[\da-f]{2}-(?!0{32})[\da-f]{32}-(?!0{16})[\da-f]{16}-[\da-f]{2}$/;
const SENTRY_TRACE = /^[\da-f]{32}-[\da-f]{16}(?:-[01])?$/;
const MAX_TRACESTATE_LENGTH = 512;
const MAX_BAGGAGE_LENGTH = 8192;
const PRINTABLE = /^[\x20-\x7e]*$/;

const sentryBaggage = (baggage: string): string | undefined => {
  const members = baggage
    .split(",")
    .map((member) => member.trim())
    .filter((member) => member.startsWith("sentry-") && member.includes("="));
  const result = members.join(",");
  return result.length === 0 || result.length > MAX_BAGGAGE_LENGTH || !PRINTABLE.test(result)
    ? undefined
    : result;
};

export const traceHeadersFrom = (headers: Headers): TraceHeaders => {
  const result: Record<string, string> = {};

  const traceparent = headers.get("traceparent")?.trim().toLowerCase();
  if (traceparent !== undefined && TRACEPARENT.test(traceparent)) {
    result.traceparent = traceparent;
    const tracestate = headers.get("tracestate")?.trim();
    if (
      tracestate !== undefined &&
      tracestate.length > 0 &&
      tracestate.length <= MAX_TRACESTATE_LENGTH &&
      PRINTABLE.test(tracestate)
    ) {
      result.tracestate = tracestate;
    }
  }

  const sentryTrace = headers.get("sentry-trace")?.trim().toLowerCase();
  if (sentryTrace !== undefined && SENTRY_TRACE.test(sentryTrace)) {
    result["sentry-trace"] = sentryTrace;
  }

  const baggage = headers.get("baggage");
  const forwardedBaggage = baggage === null ? undefined : sentryBaggage(baggage);
  if (forwardedBaggage !== undefined) result.baggage = forwardedBaggage;

  return result;
};
