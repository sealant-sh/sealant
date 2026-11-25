/**
 * The observers a sealant server process installs: Effect's own OTLP exporters for its spans and
 * log lines, a Sentry client for its errors, and the credential redaction over all three, so every
 * exporter receives only redacted data.
 *
 * An Effect-launched process (the API) provides {@link observedLive}. A process whose Effect
 * programs start from Promise code (the worker, the SSH gateway) calls
 * {@link installProcessObservability} once at startup, and each of its Effect roots runs through
 * {@link withProcessObservers}.
 */
import {
  Context,
  Duration,
  Effect,
  ErrorReporter,
  Exit,
  Layer,
  Option,
  Scope,
  Tracer,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability";

import type { ObservabilityConfig, ObservabilitySetting } from "./config.js";
import { CredentialRedactionLive } from "./redaction.js";
import { type CaptureContext, makeSentryErrors, type SentryErrors } from "./sentry.js";

/** How long shutdown waits for the last spans, logs and errors to leave. */
export const SHUTDOWN_FLUSH = Duration.seconds(2);
const EXPORT_INTERVAL = Duration.seconds(5);
const MAX_BATCH = 512;

/** Span attributes that identify a person rather than the request, never exported. */
const DROPPED_ATTRIBUTES: ReadonlySet<string> = new Set(["client.address", "user_agent.original"]);

/**
 * `tracer`, deciding sampling at `rate` for the traces this process starts (a root span), keeping
 * the decision a parent made (a local parent's, or a remote one's `traceparent` flag), and dropping
 * the attributes in {@link DROPPED_ATTRIBUTES}.
 */
export const samplingTracer = (
  tracer: Tracer.Tracer,
  rate: number,
  random: () => number = Math.random,
): Tracer.Tracer =>
  Tracer.make({
    ...tracer,
    span: (options) => {
      const root = options.root || Option.isNone(options.parent);
      const span = tracer.span({
        ...options,
        sampled: options.sampled && (!root || rate >= 1 || random() < rate),
      });
      const attribute = span.attribute.bind(span);
      span.attribute = (key, value) => {
        if (!DROPPED_ATTRIBUTES.has(key)) attribute(key, value);
      };
      return span;
    },
  });

const resourceOf = (config: ObservabilityConfig) => ({
  serviceName: config.serviceName,
  ...(config.release === undefined ? {} : { serviceVersion: config.release }),
  attributes: {
    "deployment.environment.name": config.environment,
    "sentry.environment": config.environment,
    ...(config.release === undefined ? {} : { "sentry.release": config.release }),
  },
});

/** The exporters for `config` and the Sentry client, before redaction. */
const exportersLayer = (config: ObservabilityConfig, sentry: SentryErrors): Layer.Layer<never> => {
  const shared = {
    resource: resourceOf(config),
    headers: config.otlp.headers,
    exportInterval: EXPORT_INTERVAL,
    maxBatchSize: MAX_BATCH,
    shutdownTimeout: SHUTDOWN_FLUSH,
  };
  const otlp = Layer.mergeAll(
    OtlpTracer.layer({ url: `${config.otlp.baseUrl}/v1/traces`, ...shared }),
    OtlpLogger.layer({
      url: `${config.otlp.baseUrl}/v1/logs`,
      ...shared,
      mergeWithExisting: true,
      excludeLogSpans: true,
    }),
  ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));

  const sampling = Layer.effect(
    Tracer.Tracer,
    Effect.map(Effect.tracer, (tracer) => samplingTracer(tracer, config.tracesSampleRate)),
  );
  const errors = Layer.mergeAll(
    ErrorReporter.layer([sentry.reporter], { mergeWithExisting: true }),
    // Errors queued at shutdown get the same bounded wait as spans and logs.
    Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.promise(() => sentry.flush(Duration.toMillis(SHUTDOWN_FLUSH))),
      ),
    ),
  );
  return Layer.mergeAll(sampling, errors).pipe(Layer.provideMerge(otlp), Layer.orDie);
};

/**
 * The redaction over whatever exporters `setting` turns on: provide it to the program, above every
 * other layer whose observations should be exported. With telemetry off it is the redaction alone.
 */
export const observedLive = (
  setting: ObservabilitySetting,
  sentry: SentryErrors | undefined = setting.kind === "on"
    ? makeSentryErrors(setting.config)
    : undefined,
): Layer.Layer<never> =>
  setting.kind === "on" && sentry !== undefined
    ? CredentialRedactionLive.pipe(Layer.provide(exportersLayer(setting.config, sentry)))
    : CredentialRedactionLive;

/** One sentence for the process's startup log saying where its telemetry goes. */
export const describeSetting = (setting: ObservabilitySetting): string => {
  switch (setting.kind) {
    case "off":
      return "telemetry: off (no SENTRY_DSN)";
    case "invalid":
      return `telemetry: off, ${setting.reason}`;
    case "on":
      return `telemetry: traces and logs to ${new URL(setting.config.otlp.baseUrl).host}, errors to Sentry (${setting.config.environment}${setting.config.release === undefined ? "" : `, ${setting.config.release}`})`;
  }
};

// ---------------------------------------------------------------------------------------------
// Promise-hosted processes
// ---------------------------------------------------------------------------------------------

/** A process's installed observers, for its Effect roots and its Promise-side error boundaries. */
export interface ProcessObservability {
  readonly setting: ObservabilitySetting;
  /** The observers' services, provided to each Effect root by {@link withProcessObservers}. */
  readonly context: Context.Context<never>;
  /** Report one failure a Promise boundary caught, redacted, with its span and safe tags. */
  readonly captureError: (error: unknown, context?: CaptureContext) => void;
  /** Flush (bounded by {@link SHUTDOWN_FLUSH}) and stop every exporter. */
  readonly shutdown: () => Promise<void>;
}

/**
 * The process's observers, once installed. Process-wide on purpose: like Effect's own default
 * tracer, it is decided once at the composition root, and the libraries whose Effect roots start
 * from Promise callbacks (`@sealant/jobs`, `@sealant/workspaces`) read it rather than have every
 * Promise API take it as an argument.
 */
let installed: ProcessObservability | undefined;

/**
 * Build `setting`'s observers for this process and install them. Call once, from the process's
 * entry point, before any Effect root runs. Never rejects: a build failure leaves telemetry off.
 */
export const installProcessObservability = async (
  setting: ObservabilitySetting,
): Promise<ProcessObservability> => {
  const sentry = setting.kind === "on" ? makeSentryErrors(setting.config) : undefined;
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(observedLive(setting, sentry), scope).pipe(
      Effect.orElseSucceed(() => Context.empty()),
    ),
  );
  const process: ProcessObservability = {
    setting,
    context,
    captureError: sentry?.captureError ?? (() => undefined),
    shutdown: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
  installed = process;
  return process;
};

/** `effect` with the installed observers; as it is when none are installed. */
export const withProcessObservers = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  installed === undefined ? effect : Effect.provideContext(effect, installed.context);

/** Report a failure a Promise boundary caught to the installed client, if any. */
export const captureProcessError = (error: unknown, context?: CaptureContext): void => {
  installed?.captureError(error, context);
};
