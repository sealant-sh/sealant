/**
 * Where a sealant server process sends its traces, logs and errors, read from its environment.
 *
 * Telemetry is off unless the process is given `SENTRY_DSN`: no DSN, no Sentry client, no OTLP
 * exporter and no network call. A DSN is never a committed default, so a self-hosted install never
 * reports to us. The OTLP endpoint is derived from the DSN (Sentry's OTLP ingestion for the DSN's
 * project); `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` replace it for a local
 * collector.
 */

/** What every exporter in one process shares. */
export interface ObservabilityConfig {
  /** The OTLP `service.name`: which process this is (`sealant-api`, `sealant-worker`, ...). */
  readonly serviceName: string;
  readonly dsn: string;
  /** `SENTRY_ENVIRONMENT`, `development` when unset. */
  readonly environment: string;
  /** The build's release, the same string its source maps were uploaded under. */
  readonly release: string | undefined;
  /** The share of new traces recorded, 0 to 1 (`SENTRY_TRACES_SAMPLE_RATE`, 1 when unset). */
  readonly tracesSampleRate: number;
  readonly otlp: {
    /** The base below which `/v1/traces` and `/v1/logs` are posted. */
    readonly baseUrl: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}

/** Whether this process reports, and if it was asked to but cannot, why not. */
export type ObservabilitySetting =
  | { readonly kind: "off" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "on"; readonly config: ObservabilityConfig };

export interface ObservabilitySettingOptions {
  readonly serviceName: string;
  /**
   * The release the bundler wrote into this build, when it wrote one. It wins over
   * `SENTRY_RELEASE`: a parent process (Mend's bundle supervisor) may hand its own release to the
   * processes it runs, and this build's source maps were uploaded under the build's release.
   */
  readonly buildRelease?: string | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

interface ParsedDsn {
  readonly origin: string;
  readonly projectId: string;
  readonly publicKey: string;
}

/** `https://<key>@<host>[/<path>]/<project>` into its parts, or why it is not a DSN. */
export const parseDsn = (dsn: string): ParsedDsn | string => {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return "SENTRY_DSN is not a URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "SENTRY_DSN must be an http(s) URL";
  }
  if (url.username === "") return "SENTRY_DSN names no public key";
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const projectId = segments.at(-1);
  if (projectId === undefined || !/^\d+$/.test(projectId)) {
    return "SENTRY_DSN names no numeric project";
  }
  const prefix = segments.slice(0, -1).join("/");
  return {
    origin: `${url.protocol}//${url.host}${prefix === "" ? "" : `/${prefix}`}`,
    projectId,
    publicKey: decodeURIComponent(url.username),
  };
};

/**
 * `OTEL_EXPORTER_OTLP_HEADERS` as OpenTelemetry writes it: `name=value` pairs separated by commas,
 * values percent-encoded.
 */
export const parseOtlpHeaders = (value: string): Record<string, string> | string => {
  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    if (pair.trim() === "") continue;
    const equals = pair.indexOf("=");
    if (equals <= 0) return "OTEL_EXPORTER_OTLP_HEADERS must be name=value pairs";
    try {
      headers[pair.slice(0, equals).trim().toLowerCase()] = decodeURIComponent(
        pair.slice(equals + 1).trim(),
      );
    } catch {
      return "OTEL_EXPORTER_OTLP_HEADERS holds a malformed percent-encoding";
    }
  }
  return headers;
};

const parseSampleRate = (value: string | undefined): number | string => {
  const text = nonEmpty(value);
  if (text === undefined) return 1;
  const rate = Number(text);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    return "SENTRY_TRACES_SAMPLE_RATE must be a number from 0 to 1";
  }
  return rate;
};

/** The setting `env` describes. Pure: reads only `env` and `options`. */
export const observabilitySettingFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  options: ObservabilitySettingOptions,
): ObservabilitySetting => {
  const dsn = nonEmpty(env["SENTRY_DSN"]);
  if (dsn === undefined) return { kind: "off" };
  const parsed = parseDsn(dsn);
  if (typeof parsed === "string") return { kind: "invalid", reason: parsed };
  const tracesSampleRate = parseSampleRate(env["SENTRY_TRACES_SAMPLE_RATE"]);
  if (typeof tracesSampleRate === "string") return { kind: "invalid", reason: tracesSampleRate };

  const endpointOverride = nonEmpty(env["OTEL_EXPORTER_OTLP_ENDPOINT"]);
  const headersOverride = nonEmpty(env["OTEL_EXPORTER_OTLP_HEADERS"]);
  const overrideHeaders = headersOverride === undefined ? {} : parseOtlpHeaders(headersOverride);
  if (typeof overrideHeaders === "string") return { kind: "invalid", reason: overrideHeaders };

  const otlp =
    endpointOverride === undefined
      ? {
          baseUrl: `${parsed.origin}/api/${parsed.projectId}/integration/otlp`,
          headers: {
            "x-sentry-auth": `sentry sentry_key=${parsed.publicKey}`,
            ...overrideHeaders,
          },
        }
      : { baseUrl: endpointOverride.replace(/\/+$/, ""), headers: overrideHeaders };

  return {
    kind: "on",
    config: {
      serviceName: options.serviceName,
      dsn,
      environment: nonEmpty(env["SENTRY_ENVIRONMENT"]) ?? "development",
      release: nonEmpty(options.buildRelease) ?? nonEmpty(env["SENTRY_RELEASE"]),
      tracesSampleRate,
      otlp,
    },
  };
};

/**
 * The release esbuild wrote into this bundle (`tooling/scripts/bundle-app.mjs` replaces the
 * expression with the build's `SENTRY_RELEASE`), or `undefined` when running from source.
 */
export const bundledRelease = (): string | undefined =>
  // Dot access, not brackets: esbuild's `define` matches this exact expression.
  nonEmpty(process.env.SEALANT_BUNDLED_SENTRY_RELEASE);
