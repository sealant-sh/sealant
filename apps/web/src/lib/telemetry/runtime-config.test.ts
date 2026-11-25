import { describe, expect, it } from "vitest";

import {
  parseBrowserTelemetryConfig,
  readBrowserTelemetryConfig,
  serializeBrowserTelemetryConfig,
} from "./runtime-config";

const DSN = "https://8b2e647a6833f93724c44b1e54c04058@sentry.example/9";

describe("readBrowserTelemetryConfig", () => {
  it("is off without a DSN, whatever else is set", () => {
    expect(readBrowserTelemetryConfig({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "prod" })).toEqual({
      status: "off",
    });
    expect(readBrowserTelemetryConfig({ SENTRY_BROWSER_DSN: "  " })).toEqual({ status: "off" });
  });

  it("defaults the environment and sample rate", () => {
    expect(readBrowserTelemetryConfig({ SENTRY_BROWSER_DSN: DSN })).toEqual({
      status: "on",
      config: { dsn: DSN, environment: "development", tracesSampleRate: 1 },
    });
  });

  it.each([
    { SENTRY_BROWSER_DSN: "not a url" },
    { SENTRY_BROWSER_DSN: "https://sentry.example/9" },
    { SENTRY_BROWSER_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: "1.5" },
    { SENTRY_BROWSER_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: "all" },
  ])("refuses %o", (env) => {
    expect(readBrowserTelemetryConfig(env).status).toBe("invalid");
  });

  it("hands the page only its three values, never another variable", () => {
    const canary = "canary-secret-5d1e8f";
    const result = readBrowserTelemetryConfig({
      SENTRY_BROWSER_DSN: DSN,
      SENTRY_ENVIRONMENT: "staging",
      SENTRY_TRACES_SAMPLE_RATE: "0.25",
      BETTER_AUTH_SECRET: canary,
      CORE_API_SERVICE_KEY: canary,
    });
    if (result.status !== "on") throw new Error(`expected on, got ${result.status}`);

    const json = serializeBrowserTelemetryConfig(result.config);
    expect(json).not.toContain(canary);
    expect(parseBrowserTelemetryConfig(json)).toEqual({
      dsn: DSN,
      environment: "staging",
      tracesSampleRate: 0.25,
    });
  });
});

describe("serializeBrowserTelemetryConfig", () => {
  it("cannot close the script tag it is written into", () => {
    const config = {
      dsn: DSN,
      environment: "</script><script>alert(1)</script>",
      tracesSampleRate: 1,
    };
    const json = serializeBrowserTelemetryConfig(config);
    expect(json).not.toContain("</script");
    expect(parseBrowserTelemetryConfig(json)).toEqual(config);
  });
});

describe("parseBrowserTelemetryConfig", () => {
  it.each(["", "{", "null", JSON.stringify({ dsn: "x", environment: "e", tracesSampleRate: 1 })])(
    "leaves telemetry off for %j",
    (text) => {
      expect(parseBrowserTelemetryConfig(text)).toBeUndefined();
    },
  );
});
