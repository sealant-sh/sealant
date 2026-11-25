import { z } from "zod";

/**
 * What the browser needs to report to Sentry, served by the web server at request time rather than
 * baked into the bundle. A self-hosted install that sets no DSN gets no config, and the browser then
 * never starts the SDK, so it makes no call to any Sentry host.
 */
export interface BrowserTelemetryConfig {
  readonly dsn: string;
  readonly environment: string;
  readonly tracesSampleRate: number;
}

/** The id of the `<script type="application/json">` tag the config travels in. */
export const BROWSER_TELEMETRY_CONFIG_ELEMENT_ID = "sealant-browser-telemetry";

const DEFAULT_ENVIRONMENT = "development";
const DEFAULT_TRACES_SAMPLE_RATE = 1;

type Env = Readonly<Record<string, string | undefined>>;

const trimmed = (value: string | undefined): string | undefined => {
  const result = value?.trim();
  return result === undefined || result.length === 0 ? undefined : result;
};

/** A Sentry DSN is `<scheme>://<public key>@<host>/<project id>`. Anything else is not one. */
const parseDsn = (value: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const isHttp = url.protocol === "https:" || url.protocol === "http:";
  const hasProject = /^\/\d+$/.test(url.pathname);
  return isHttp && url.username.length > 0 && url.password.length === 0 && hasProject
    ? value
    : undefined;
};

const parseSampleRate = (value: string | undefined): number | undefined => {
  if (value === undefined) return DEFAULT_TRACES_SAMPLE_RATE;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : undefined;
};

export type BrowserTelemetryConfigResult =
  | { readonly status: "off" }
  | { readonly status: "on"; readonly config: BrowserTelemetryConfig }
  | { readonly status: "invalid"; readonly reason: string };

/**
 * Reads the browser's Sentry settings from the web server's environment: `SENTRY_BROWSER_DSN` (the
 * sealant-web project; `SENTRY_DSN` is left for the server's own reporting), `SENTRY_ENVIRONMENT`
 * and `SENTRY_TRACES_SAMPLE_RATE`. Only these three values ever reach the page.
 */
export const readBrowserTelemetryConfig = (env: Env): BrowserTelemetryConfigResult => {
  const rawDsn = trimmed(env.SENTRY_BROWSER_DSN);
  if (rawDsn === undefined) return { status: "off" };

  const dsn = parseDsn(rawDsn);
  if (dsn === undefined) {
    return {
      status: "invalid",
      reason: "SENTRY_BROWSER_DSN is not a Sentry DSN (https://<key>@<host>/<project id>).",
    };
  }

  const tracesSampleRate = parseSampleRate(trimmed(env.SENTRY_TRACES_SAMPLE_RATE));
  if (tracesSampleRate === undefined) {
    return { status: "invalid", reason: "SENTRY_TRACES_SAMPLE_RATE must be a number from 0 to 1." };
  }

  return {
    status: "on",
    config: {
      dsn,
      environment: trimmed(env.SENTRY_ENVIRONMENT) ?? DEFAULT_ENVIRONMENT,
      tracesSampleRate,
    },
  };
};

/**
 * The config as the body of a JSON script tag. `<` is escaped so no value can close the tag early.
 */
export const serializeBrowserTelemetryConfig = (config: BrowserTelemetryConfig): string =>
  JSON.stringify({
    dsn: config.dsn,
    environment: config.environment,
    tracesSampleRate: config.tracesSampleRate,
  }).replaceAll("<", "\\u003c");

const browserTelemetryConfigSchema = z.object({
  dsn: z.string().refine((value) => parseDsn(value) !== undefined),
  environment: z.string(),
  tracesSampleRate: z.number().min(0).max(1),
});

/** Parses the tag's body back. Anything malformed means telemetry stays off. */
export const parseBrowserTelemetryConfig = (text: string): BrowserTelemetryConfig | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = browserTelemetryConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
