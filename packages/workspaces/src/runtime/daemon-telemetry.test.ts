import { Effect, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import {
  daemonSentryConfigFromEnv,
  daemonTelemetryEnv,
  daemonTelemetryFor,
  type DaemonTelemetry,
  withLaunchTelemetry,
} from "./daemon-telemetry.js";
import { cases } from "./docker-runtime-adapter.golden-fixture.js";
import { nativeBootEnv } from "./native-boot-env.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const DSN = "https://k3y@sentry.example.com/10";

describe("daemonSentryConfigFromEnv", () => {
  it("is off without SEALANTD_SENTRY_DSN, even when the worker itself reports", () => {
    expect(daemonSentryConfigFromEnv({ SENTRY_DSN: "https://a@sentry.example.com/2" })).toBe(
      undefined,
    );
  });

  it("takes the daemon project, its host, and the worker's environment by default", () => {
    expect(
      daemonSentryConfigFromEnv({ SEALANTD_SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "preview" }),
    ).toEqual({
      sentryDsn: DSN,
      environment: "preview",
      release: undefined,
      host: "sentry.example.com",
    });
  });

  it("refuses a DSN that is not a URL instead of reporting nowhere", () => {
    expect(daemonSentryConfigFromEnv({ SEALANTD_SENTRY_DSN: "not a dsn" })).toBe(undefined);
  });
});

describe("a launch's daemon telemetry", () => {
  const config = daemonSentryConfigFromEnv({
    SEALANTD_SENTRY_DSN: DSN,
    SEALANTD_SENTRY_ENVIRONMENT: "check",
    SEALANTD_SENTRY_RELEASE: "sealantd@0.21.0-next.217",
  });

  it("is the SEALANT_-prefixed names sealantd reads, never the image's own SENTRY_DSN", () => {
    expect(daemonTelemetryEnv(daemonTelemetryFor({ traceparent: TRACEPARENT }, config))).toEqual([
      ["SEALANT_TRACEPARENT", TRACEPARENT],
      ["SEALANT_SENTRY_DSN", DSN],
      ["SEALANT_SENTRY_ENVIRONMENT", "check"],
      ["SEALANT_SENTRY_RELEASE", "sealantd@0.21.0-next.217"],
    ]);
  });

  it("still carries the launching span when the deployment names no daemon project", () => {
    expect(daemonTelemetryFor({ traceparent: TRACEPARENT }, undefined)).toEqual({
      traceparent: TRACEPARENT,
    });
    expect(daemonTelemetryFor(undefined, undefined)).toBe(undefined);
  });
});

describe("nativeBootEnv", () => {
  it("puts the daemon's telemetry after the blueprint's env, so a stored spec cannot replace it", () => {
    const env = nativeBootEnv(
      {
        ...cases.gitSource,
        blueprint: {
          ...cases.gitSource.blueprint,
          runtime: {
            ...cases.gitSource.blueprint.runtime,
            env: { SEALANT_SENTRY_DSN: "https://x@elsewhere.example/1" },
          },
        },
        telemetry: { traceparent: TRACEPARENT, sentryDsn: DSN },
      },
      { secretEnvFile: false, dotfiles: false },
    );
    expect(env["SEALANT_SENTRY_DSN"]).toBe(DSN);
    expect(env["SEALANT_TRACEPARENT"]).toBe(TRACEPARENT);
  });
});

describe("withLaunchTelemetry", () => {
  it("hands the daemon the span the launch was called in, when that span is exported", async () => {
    const exporting = Effect.map(Effect.tracer, (tracer) => Tracer.make({ ...tracer }));
    const { launch, span } = await Effect.runPromise(
      Effect.flatMap(exporting, (tracer) =>
        Effect.gen(function* () {
          const current = yield* Effect.currentSpan;
          return {
            launch: withLaunchTelemetry<{
              readonly runId: string;
              readonly telemetry?: DaemonTelemetry;
            }>({ runId: "run_1" }, undefined),
            span: current,
          };
        }).pipe(Effect.withSpan("sealant.workspace.launch"), Effect.withTracer(tracer)),
      ),
    );
    expect(launch.telemetry?.traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
  });

  it("hands over no span that no exporter records", async () => {
    const launch = await Effect.runPromise(
      Effect.sync(() =>
        withLaunchTelemetry<{ readonly telemetry?: DaemonTelemetry }>({}, undefined),
      ).pipe(Effect.withSpan("sealant.workspace.launch")),
    );
    expect(launch.telemetry).toBe(undefined);
  });

  it("keeps the telemetry a launch names itself", () => {
    const named = { telemetry: { traceparent: TRACEPARENT } };
    expect(withLaunchTelemetry(named, undefined)).toBe(named);
  });
});
