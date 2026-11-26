/**
 * What a workspace's sealantd is told about tracing at boot: the launching span, so the boot is
 * one trace with the create that asked for it, and where the daemon reports its own spans and
 * errors (the sealantd Sentry project). Nothing here is a secret: a DSN names a project and its
 * public key, and a `traceparent` names a span.
 *
 * The deployment opts in with `SEALANTD_SENTRY_DSN` on the worker; with it unset a workspace's
 * daemon exports nothing and makes no network call for telemetry. The launching span travels
 * whether or not a DSN is set, so a daemon given its DSN another way still joins the trace.
 *
 * sealantd reads `SEALANT_`-prefixed names, so a workspace image's own `SENTRY_DSN` stays the
 * user's, and keeps them out of the harness's environment (sealantd SLNT-1351):
 * - a container boot (`docker`, the native runtimes): `SEALANT_TRACEPARENT`,
 *   `SEALANT_TRACESTATE` and `SEALANT_SENTRY_{DSN,ENVIRONMENT,RELEASE}` in its environment;
 * - a `host-vm` boot: the `telemetry` object of the staged `boot-env.json`, which the runner hands
 *   the guest.
 */
import { Context, Fiber, Tracer } from "effect";
import { z } from "zod";

/** The daemon's telemetry for one launch. */
export const daemonTelemetrySchema = z.strictObject({
  /** The W3C `traceparent` of the span that launched this executor. */
  traceparent: z.string().trim().min(1).optional(),
  tracestate: z.string().trim().min(1).optional(),
  /** The sealantd Sentry project's DSN; absent, the daemon exports nothing. */
  sentryDsn: z.string().trim().min(1).optional(),
  environment: z.string().trim().min(1).optional(),
  /** `sealantd@<version>`; absent, the daemon reports the release its image was built as. */
  release: z.string().trim().min(1).optional(),
});

export type DaemonTelemetry = z.infer<typeof daemonTelemetrySchema>;

/** Where the deployment's workspace daemons report: what the worker was configured with. */
export interface DaemonSentryConfig {
  readonly sentryDsn: string;
  readonly environment: string | undefined;
  readonly release: string | undefined;
  /** The DSN's host: the one host a restricted workspace's egress proxy must let the daemon reach. */
  readonly host: string;
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * The deployment's daemon telemetry from the worker's environment: `SEALANTD_SENTRY_DSN`, and
 * `SEALANTD_SENTRY_ENVIRONMENT` (else the worker's own `SENTRY_ENVIRONMENT`) and
 * `SEALANTD_SENTRY_RELEASE`. `undefined` when no DSN is set, or the DSN names no host.
 */
export const daemonSentryConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): DaemonSentryConfig | undefined => {
  const sentryDsn = nonEmpty(env["SEALANTD_SENTRY_DSN"]);
  if (sentryDsn === undefined) return undefined;
  let host: string;
  try {
    host = new URL(sentryDsn).hostname;
  } catch {
    return undefined;
  }
  if (host === "") return undefined;
  return {
    sentryDsn,
    environment:
      nonEmpty(env["SEALANTD_SENTRY_ENVIRONMENT"]) ?? nonEmpty(env["SENTRY_ENVIRONMENT"]),
    release: nonEmpty(env["SEALANTD_SENTRY_RELEASE"]),
    host,
  };
};

/** One launch's telemetry: the launching span's carrier and the deployment's daemon project. */
export const daemonTelemetryFor = (
  carrier: { readonly traceparent: string; readonly tracestate?: string | undefined } | undefined,
  config: DaemonSentryConfig | undefined,
): DaemonTelemetry | undefined => {
  const telemetry: DaemonTelemetry = {
    ...(carrier === undefined ? {} : { traceparent: carrier.traceparent }),
    ...(carrier?.tracestate === undefined ? {} : { tracestate: carrier.tracestate }),
    ...(config === undefined ? {} : { sentryDsn: config.sentryDsn }),
    ...(config?.environment === undefined ? {} : { environment: config.environment }),
    ...(config?.release === undefined ? {} : { release: config.release }),
  };
  return Object.keys(telemetry).length === 0 ? undefined : telemetry;
};

/** `telemetry` as a container boot's environment, in a fixed order. */
export const daemonTelemetryEnv = (
  telemetry: DaemonTelemetry | undefined,
): Array<readonly [string, string]> => {
  if (telemetry === undefined) return [];
  const entries: Array<readonly [string, string]> = [];
  const push = (key: string, value: string | undefined) => {
    if (value !== undefined) entries.push([key, value]);
  };
  push("SEALANT_TRACEPARENT", telemetry.traceparent);
  push("SEALANT_TRACESTATE", telemetry.tracestate);
  push("SEALANT_SENTRY_DSN", telemetry.sentryDsn);
  push("SEALANT_SENTRY_ENVIRONMENT", telemetry.environment);
  push("SEALANT_SENTRY_RELEASE", telemetry.release);
  return entries;
};

/** Every environment name {@link daemonTelemetryEnv} writes. */
export const DAEMON_TELEMETRY_ENV_NAMES: ReadonlySet<string> = new Set([
  "SEALANT_TRACEPARENT",
  "SEALANT_TRACESTATE",
  "SEALANT_SENTRY_DSN",
  "SEALANT_SENTRY_ENVIRONMENT",
  "SEALANT_SENTRY_RELEASE",
]);

/**
 * The calling Effect fiber's current span as a W3C carrier, or `undefined` outside a fiber or a
 * span, or when the fiber's tracer exports nothing (Effect's native tracer): a daemon handed a span
 * no exporter records would hang its boot off a parent that never arrives. Synchronous: an
 * adapter's `launch`, called from `Effect.tryPromise`, reads it in its first synchronous step,
 * while the launching fiber is still current.
 */
export const callingFiberTraceCarrier = (): { readonly traceparent: string } | undefined => {
  const fiber = Fiber.getCurrent();
  if (fiber === undefined || fiber.getRef(Tracer.Tracer) === Tracer.nativeTracer) return undefined;
  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (span === undefined) return undefined;
  return {
    traceparent: `00-${span.traceId.padStart(32, "0")}-${span.spanId}-${span.sampled ? "01" : "00"}`,
  };
};

/**
 * `launch` with its daemon telemetry: what the launch names itself, else the calling fiber's span
 * and `config`. Call it in the adapter's first synchronous step.
 */
export const withLaunchTelemetry = <L extends { readonly telemetry?: DaemonTelemetry | undefined }>(
  launch: L,
  config: DaemonSentryConfig | undefined,
): L => {
  if (launch.telemetry !== undefined) return launch;
  const telemetry = daemonTelemetryFor(callingFiberTraceCarrier(), config);
  return telemetry === undefined ? launch : { ...launch, telemetry };
};
