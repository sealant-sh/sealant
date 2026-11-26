import { Effect, Option, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import {
  routeIdAttributes,
  sentryAttributes,
  sentryShapedTracer,
  summarizeSql,
  templatePath,
} from "./sentry-span.js";

const attrs = (entries: Record<string, unknown>): ReadonlyMap<string, unknown> =>
  new Map(Object.entries(entries));

describe("summarizeSql", () => {
  it.each([
    [
      `select "id", "workspace_id", "secret_env_sealed", "deletion_token" from "workspace_sessions" where "workspace_sessions"."id" = $1 limit $2`,
      "SELECT workspace_sessions",
    ],
    [
      `select "d0"."id" as "id", "d0"."name" as "name" from "workspaces" as "d0" where "d0"."id" = $1`,
      "SELECT workspaces",
    ],
    [
      `select max("sequence") from "telemetry_events" where "runtime_id" = $1`,
      "SELECT telemetry_events",
    ],
    [
      `insert into "telemetry_artifacts" ("id", "run_id") values ($1, $2)`,
      "INSERT telemetry_artifacts",
    ],
    [`update "runs" set "status" = $1 where "runs"."id" = $2`, "UPDATE runs"],
    [`delete from public."ssh_keys" where "id" = $1`, "DELETE ssh_keys"],
    [`SELECT set_config('sealant.capture_ledger', $1, true)`, "SELECT set_config"],
    [
      `with "locked" as (select "id" from "jobs" for update skip locked) update "workspace_build_jobs" set "state" = $1`,
      "UPDATE workspace_build_jobs",
    ],
    [
      `select "x" from (select "id" as "x" from "inner_table") "t" join "outer_table" on true`,
      "SELECT inner_table",
    ],
    [
      `\n  SELECT sealant_user_id FROM user_sealant_identities WHERE user_id = $1 LIMIT 1`,
      "SELECT user_sealant_identities",
    ],
    ["BEGIN", "BEGIN"],
  ])("%s -> %s", (sql, summary) => {
    expect(summarizeSql(sql)?.summary).toBe(summary);
  });

  it("never reads a string literal as a table", () => {
    expect(summarizeSql(`select 'from secret_table' from "runs"`)?.collection).toBe("runs");
  });
});

describe("templatePath", () => {
  it("replaces the segments that name one record", () => {
    expect(templatePath("/v1/sessions/sess_01JDCE5Q2Z8Y7X6W5V4T3S2R1Q/output")).toBe(
      "/v1/sessions/*/output",
    );
    expect(templatePath("/v1/workspaces/8f14e45f-ceea-467a-9575-0f6c3c8f0e2a/exec")).toBe(
      "/v1/workspaces/*/exec",
    );
    expect(templatePath("/repos/acme/widgets/pulls/123")).toBe("/repos/acme/widgets/pulls/*");
    expect(templatePath("/v1/runs")).toBe("/v1/runs");
  });
});

describe("routeIdAttributes", () => {
  it("copies only the parameters named for an ID", () => {
    expect(
      routeIdAttributes(
        "/v1/workspaces/:workspaceId/files/:path",
        "/v1/workspaces/ws_1/files/src%2Fa.ts",
      ),
    ).toEqual({ "sealant.workspace_id": "ws_1" });
  });
});

describe("sentryAttributes", () => {
  it("gives a database span an operation, a table and a short description", () => {
    const shaped = sentryAttributes(
      "postgres",
      "client",
      attrs({
        "db.system.name": "postgresql",
        "db.query.text": `select "id", "capture_token_sealed" from "workspace_capture_drains" where "run_id" = $1`,
      }),
    );
    expect(shaped).toEqual({
      "sentry.op": "db",
      "sentry.description": "SELECT workspace_capture_drains",
      "db.system": "postgresql",
      "db.operation.name": "SELECT",
      "db.collection.name": "workspace_capture_drains",
      "db.query.summary": "SELECT workspace_capture_drains",
    });
  });

  it("names a contract span's area as its op and its name as its description", () => {
    expect(sentryAttributes("sealant.session.output", "internal", attrs({}))).toEqual({
      "sentry.op": "sealant.session",
      "sentry.description": "sealant.session.output",
    });
    expect(sentryAttributes("BoatAccountRepo.launchReports", "internal", attrs({}))).toEqual({
      "sentry.op": "function",
      "sentry.description": "BoatAccountRepo.launchReports",
    });
  });

  it("keeps an op and description the span set itself", () => {
    expect(
      sentryAttributes(
        "sealant.sdk.sessions.get_session_output",
        "client",
        attrs({ "sentry.op": "sealant.sdk", "sentry.description": "sessions.getSessionOutput" }),
      ),
    ).toEqual({});
  });

  it("describes an outgoing request by its templated path, never its IDs", () => {
    const shaped = sentryAttributes(
      "GET",
      "client",
      attrs({
        "http.request.method": "GET",
        "url.full": "https://api.github.com/repos/acme/widgets/pulls/123",
        "url.path": "/repos/acme/widgets/pulls/123",
      }),
    );
    expect(shaped["sentry.op"]).toBe("http.client");
    expect(shaped["sentry.description"]).toBe("GET /repos/acme/widgets/pulls/*");
    expect(
      sentryAttributes(
        "GET",
        "client",
        attrs({ "http.request.method": "GET", "url.template": "/v1/sessions/:sessionId/output" }),
      )["sentry.description"],
    ).toBe("GET /v1/sessions/:sessionId/output");
  });

  it("describes an incoming request by its route and records the IDs it names", () => {
    expect(
      sentryAttributes(
        "GET",
        "server",
        attrs({
          "http.request.method": "GET",
          "http.route": "/v1/sessions/:sessionId/output",
          "url.path": "/v1/sessions/sess_01JDCE5Q2Z/output",
        }),
      ),
    ).toEqual({
      "sentry.op": "http.server",
      "sentry.description": "GET /v1/sessions/:sessionId/output",
      "sealant.session_id": "sess_01JDCE5Q2Z",
    });
    expect(
      sentryAttributes(
        "GET",
        "server",
        attrs({ "http.request.method": "GET", "url.path": "/v1/nope/ws_3f9a8b7c6d" }),
      )["sentry.description"],
    ).toBe("GET /v1/nope/*");
  });

  it("marks a job delivery as a queue span named for its queue", () => {
    expect(
      sentryAttributes(
        "sealant.job.process",
        "consumer",
        attrs({ "messaging.system": "pg-boss", "messaging.destination.name": "workspace-build" }),
      ),
    ).toEqual({ "sentry.op": "queue.process", "sentry.description": "workspace-build" });
  });

  it("names a transaction", () => {
    expect(sentryAttributes("sql.transaction", "client", attrs({}))).toEqual({
      "sentry.op": "db.sql.transaction",
      "sentry.description": "transaction",
    });
  });
});

/** Runs `effect` under the shaped native tracer and returns every span that ended. */
const ended = async (effect: Effect.Effect<unknown>): Promise<Tracer.Span[]> => {
  const spans: Tracer.Span[] = [];
  const recording = Effect.map(Effect.tracer, (tracer) =>
    Tracer.make({
      ...tracer,
      span: (options) => {
        const span = tracer.span(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          spans.push(span);
        };
        return span;
      },
    }),
  );
  await Effect.runPromise(
    Effect.flatMap(recording, (tracer) => Effect.withTracer(effect, sentryShapedTracer(tracer))),
  );
  return spans;
};

describe("sentryShapedTracer", () => {
  it("hangs a statement off the code that ran it, past Drizzle's wrapper", async () => {
    const spans = await ended(
      Effect.void.pipe(
        Effect.withSpan("postgres", {
          kind: "client",
          attributes: {
            "db.system.name": "postgresql",
            "db.query.text": `select "id" from "runs" where "id" = $1`,
          },
        }),
        Effect.withSpan("drizzle.operation"),
        Effect.withSpan("sealant.run.get"),
      ),
    );
    expect(spans.map((span) => span.name)).toEqual(["postgres", "sealant.run.get"]);
    const [statement, handler] = spans;
    expect(statement && Option.getOrUndefined(statement.parent)?.spanId).toBe(handler?.spanId);
    expect(statement?.attributes.get("sentry.description")).toBe("SELECT runs");
    expect(handler?.attributes.get("sentry.op")).toBe("sealant.run");
  });
});
