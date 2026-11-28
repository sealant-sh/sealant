import { Effect, Option, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import {
  describeSpanName,
  routeIdAttributes,
  sentryShapedTracer,
  shapeSpan,
  summarizeSql,
  templatePath,
  type SpanShapingOptions,
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
  it("replaces every segment that could name a record or carry a code", () => {
    expect(templatePath("/v1/sessions/sess_01JDCE5Q2Z8Y7X6W5V4T3S2R1Q/output")).toBe(
      "/v1/sessions/*/output",
    );
    expect(templatePath("/v1/workspaces/8f14e45f-ceea-467a-9575-0f6c3c8f0e2a/exec")).toBe(
      "/v1/workspaces/*/exec",
    );
    expect(templatePath("/repos/acme/widgets/pulls/123")).toBe("/repos/acme/widgets/pulls/*");
    expect(templatePath("/api/me/cli-auth/57TX-M9HG")).toBe("/api/me/cli-auth/*");
    expect(templatePath("/v1/sandboxes/bx_abcdefgh")).toBe("/v1/sandboxes/*");
    expect(templatePath("/v1/workspaces/exec-as-user")).toBe("/v1/workspaces/exec-as-user");
    expect(templatePath("/v1/runs")).toBe("/v1/runs");
    expect(templatePath("/")).toBe("/");
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

describe("shapeSpan", () => {
  it("names a statement by its operation and table", () => {
    expect(
      shapeSpan(
        "postgres",
        "client",
        attrs({
          "db.system.name": "postgresql",
          "db.query.text": `select "id", "capture_token_sealed" from "workspace_capture_drains" where "run_id" = $1`,
        }),
      ),
    ).toEqual({
      name: "SELECT workspace_capture_drains",
      attributes: {
        "sentry.op": "db",
        "sentry.description": "SELECT workspace_capture_drains",
        "db.system": "postgresql",
        "db.operation.name": "SELECT",
        "db.collection.name": "workspace_capture_drains",
        "db.query.summary": "SELECT workspace_capture_drains",
      },
    });
  });

  it("names a contract span's area as its op and says in words what it does", () => {
    expect(shapeSpan("sealant.workspace.create", "internal", attrs({}))).toEqual({
      name: "sealant.workspace.create",
      attributes: {
        "sentry.op": "sealant.workspace",
        "sentry.description": "create workspace",
        "code.function.name": "sealant.workspace.create",
      },
    });
    expect(shapeSpan("sealant.run.get_timeline", "internal", attrs({})).attributes).toMatchObject({
      "sentry.description": "get run timeline",
    });
  });

  it("keeps an op and description the span set itself", () => {
    expect(
      shapeSpan(
        "sealant.sdk.sessions.get_session_output",
        "client",
        attrs({
          "sentry.op": "sealant.sdk",
          "sentry.description": "get session output",
          "code.function.name": "sealant.sdk.sessions.get_session_output",
        }),
      ).attributes,
    ).toEqual({});
  });

  it("names an outgoing request by its template or templated path, never its host or IDs", () => {
    expect(
      shapeSpan(
        "GET",
        "client",
        attrs({
          "http.request.method": "GET",
          "url.full": "https://api.github.com/repos/acme/widgets/pulls/123",
          "url.path": "/repos/acme/widgets/pulls/123",
          "server.address": "api.github.com",
        }),
      ),
    ).toEqual({
      name: "GET /repos/acme/widgets/pulls/*",
      attributes: {
        "sentry.op": "http.client",
        "sentry.description": "GET /repos/acme/widgets/pulls/*",
        "url.template": "/repos/acme/widgets/pulls/*",
      },
    });
    expect(
      shapeSpan(
        "POST",
        "client",
        attrs({ "http.request.method": "POST", "url.template": "/v1/sessions/:sessionId/input" }),
      ).name,
    ).toBe("POST /v1/sessions/:sessionId/input");
  });

  it("names a handled request by its route and records the IDs it names", () => {
    expect(
      shapeSpan(
        "GET",
        "server",
        attrs({
          "http.request.method": "GET",
          "http.route": "/v1/sessions/:sessionId/output",
          "url.path": "/v1/sessions/sess_01JDCE5Q2Z/output",
        }),
      ),
    ).toEqual({
      name: "GET /v1/sessions/:sessionId/output",
      attributes: {
        "sentry.op": "http.server",
        "sentry.description": "GET /v1/sessions/:sessionId/output",
        "sealant.session_id": "sess_01JDCE5Q2Z",
      },
    });
  });

  it("names a request no route matched by its templated path", () => {
    const unmatched = shapeSpan(
      "GET",
      "server",
      attrs({ "http.request.method": "GET", "url.path": "/api/me/cli-auth/57TX-M9HG" }),
    );
    expect(unmatched.name).toBe("GET /api/me/cli-auth/*");
    expect(unmatched.attributes["sentry.description"]).toBe("GET /api/me/cli-auth/*");
    expect(shapeSpan("GET", "server", attrs({ "http.request.method": "GET" })).name).toBe("GET *");
  });

  it("marks a job delivery as a queue span described by its queue", () => {
    expect(
      shapeSpan(
        "sealant.job.process",
        "consumer",
        attrs({ "messaging.system": "pg-boss", "messaging.destination.name": "workspace-build" }),
      ),
    ).toEqual({
      name: "sealant.job.process",
      attributes: { "sentry.op": "queue.process", "sentry.description": "workspace-build" },
    });
  });

  it("describes a transaction by its own name, not as a statement", () => {
    expect(
      shapeSpan("sealant.db.transaction", "internal", attrs({ "db.system.name": "postgresql" })),
    ).toEqual({
      name: "sealant.db.transaction",
      attributes: {
        "sentry.op": "sealant.db",
        "sentry.description": "database transaction",
        "code.function.name": "sealant.db.transaction",
      },
    });
  });
});

/** Runs `effect` under the shaped native tracer and returns every span that ended. */
const ended = async (
  effect: Effect.Effect<unknown>,
  shaping?: SpanShapingOptions,
): Promise<Tracer.Span[]> => {
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
    Effect.flatMap(recording, (tracer) =>
      Effect.withTracer(effect, sentryShapedTracer(tracer, shaping)),
    ),
  );
  return spans;
};

describe("describeSpanName", () => {
  it.each([
    ["sealant.workspace.create", "sealant.workspace", "create workspace"],
    [
      "sealant.workspace.resolve_credential_refs",
      "sealant.workspace",
      "resolve workspace credentials",
    ],
    ["sealant.workspace.get", "sealant.workspace", "get workspace"],
    ["sealant.workspace.stop", "sealant.workspace", "stop workspace"],
    ["sealant.workspace.build", "sealant.workspace", "build workspace"],
    ["sealant.workspace.launch", "sealant.workspace", "launch workspace"],
    ["sealant.workspace.exec", "sealant.workspace", "exec in workspace"],
    ["sealant.workspace.list", "sealant.workspace", "list workspaces"],
    ["sealant.registry.get", "sealant.registry", "get registry settings"],
    ["sealant.profile.list", "sealant.profile", "list profiles"],
    ["sealant.ssh_key.create", "sealant.ssh_key", "create ssh key"],
    ["sealant.session.create", "sealant.session", "create session"],
    ["sealant.session.wait_for_recorder", "sealant.session", "wait for output recorder"],
    ["sealant.github.resolve_clone_auth", "sealant.github", "resolve repository clone token"],
    ["sealant.session.get_output", "sealant.session", "get session output"],
    ["sealant.session.reconcile", "sealant.session", "reconcile session"],
    ["sealant.daemon.connect", "sealant.daemon", "connect to daemon"],
    ["sealant.daemon.open_session", "sealant.daemon", "call daemon: open session"],
    ["sealant.daemon.exec", "sealant.daemon", "call daemon: exec"],
    ["sealant.daemon.close_session", "sealant.daemon", "call daemon: close session"],
    ["sealant.sdk.workspaces.create_workspace", "sealant.sdk", "create workspace"],
    ["sealant.sdk.sessions.create_session", "sealant.sdk", "create session"],
    ["sealant.sdk.sessions.get_session_output", "sealant.sdk", "get session output"],
  ])("describes %s as %s — %s", (name, op, description) => {
    expect(describeSpanName(name)).toEqual({ op, description });
  });

  it("leaves a name outside the contract alone", () => {
    expect(describeSpanName("BoatAccountRepo.launchReports")).toBeUndefined();
    expect(describeSpanName("sealant.workspace")).toBeUndefined();
  });

  it("never repeats the op in the description", () => {
    for (const name of [
      "sealant.workspace.create",
      "sealant.session.wait_for_recorder",
      "sealant.daemon.open_session",
      "sealant.sdk.workspaces.get_workspace",
    ]) {
      expect(describeSpanName(name)?.description).not.toContain("sealant");
    }
  });
});

describe("sentryShapedTracer", () => {
  it("hangs a statement off the code that ran it, past Drizzle's wrapper, named by its table", async () => {
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
    expect(spans.map((span) => span.name)).toEqual(["SELECT runs", "sealant.run.get"]);
    const [statement, handler] = spans;
    expect(statement && Option.getOrUndefined(statement.parent)?.spanId).toBe(handler?.spanId);
    expect(statement?.attributes.get("sentry.description")).toBe("SELECT runs");
    expect(handler?.attributes.get("sentry.op")).toBe("sealant.run");
  });

  it("names a handled request by the route matched after its span started", async () => {
    const spans = await ended(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan("http.route", "/v1/runs/:runId");
        yield* Effect.annotateCurrentSpan("url.path", "/v1/runs/run_01JDCE5Q2Z");
      }).pipe(
        Effect.withSpan("GET", { kind: "server", attributes: { "http.request.method": "GET" } }),
      ),
    );
    expect(spans.map((span) => span.name)).toEqual(["GET /v1/runs/:runId"]);
    expect(spans[0]?.attributes.get("sealant.run_id")).toBe("run_01JDCE5Q2Z");
  });

  it("exports a transaction and a parentless Drizzle wrapper under sealant's names", async () => {
    const spans = await ended(
      Effect.all([
        Effect.void.pipe(
          Effect.withSpan("sql.transaction", { attributes: { "db.system.name": "postgresql" } }),
        ),
        Effect.void.pipe(Effect.withSpan("drizzle.operation")),
      ]),
    );
    expect(spans.map((span) => [span.name, span.attributes.get("sentry.description")])).toEqual([
      ["sealant.db.transaction", "database transaction"],
      ["sealant.db.query", "run database query"],
    ]);
  });

  it("starts no trace for Drizzle's client being made", async () => {
    const spans = await ended(Effect.void.pipe(Effect.withSpan("PgDrizzle.make")));
    expect(spans.map((span) => [span.name, span.sampled])).toEqual([["PgDrizzle.make", false]]);
  });

  it("puts the release and environment on every span", async () => {
    const spans = await ended(
      Effect.void.pipe(Effect.withSpan("sealant.run.get"), Effect.withSpan("GET")),
      { release: "sealant-server@1.2.3", environment: "test" },
    );
    for (const span of spans) {
      expect(span.attributes.get("sentry.release")).toBe("sealant-server@1.2.3");
      expect(span.attributes.get("sentry.environment")).toBe("test");
    }
  });
});
