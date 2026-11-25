import { describe, expect, it } from "vitest";

import { observabilitySettingFromEnv } from "./config.js";

const DSN = "https://50f86420d4e4c086bd544fbbfa77d859@sentry.example.test/2";

describe("observabilitySettingFromEnv", () => {
  it("keeps the release the build wrote over one a parent process passed in the environment", () => {
    const setting = observabilitySettingFromEnv(
      { SENTRY_DSN: DSN, SENTRY_RELEASE: "mend-server@1.0.0" },
      { serviceName: "sealant-worker", buildRelease: "sealant-server@0.22.0-next.4" },
    );
    expect(setting.kind === "on" && setting.config.release).toBe("sealant-server@0.22.0-next.4");
  });

  it("sends OTLP to a configured collector instead of the DSN's project, with its headers", () => {
    const setting = observabilitySettingFromEnv(
      {
        SENTRY_DSN: DSN,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20abc,x-team=core",
      },
      { serviceName: "sealant-api" },
    );
    expect(setting.kind === "on" && setting.config.otlp).toEqual({
      baseUrl: "http://localhost:4318",
      headers: { authorization: "Basic abc", "x-team": "core" },
    });
  });

  it("turns telemetry off, saying why, for a DSN or rate it cannot use", () => {
    const options = { serviceName: "sealant-api" };
    expect(
      observabilitySettingFromEnv({ SENTRY_DSN: "https://sentry.example.test/2" }, options),
    ).toEqual({ kind: "invalid", reason: "SENTRY_DSN names no public key" });
    expect(
      observabilitySettingFromEnv({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: "2" }, options)
        .kind,
    ).toBe("invalid");
  });
});
