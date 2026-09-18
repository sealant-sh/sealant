import { BudgetExceededError } from "@sealant/api-contracts";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { makeRateWindow } from "./budgets.js";
import {
  CurrentPrincipal,
  makeServicePrincipals,
  servicePrincipalMiddleware,
} from "./service-principals.js";

const ok = Effect.succeed(HttpServerResponse.text("ok"));

const statusOf = (
  keys: string | undefined,
  url: string,
  init: { readonly method?: string; readonly headers?: Record<string, string> } = {},
) =>
  Effect.runPromise(
    servicePrincipalMiddleware(
      makeServicePrincipals(keys),
      "gateway-secret",
    )(ok).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`http://localhost${url}`, init)),
      ),
      Effect.map((response) => response.status),
    ),
  );

/** The principal kind a handler behind the gate observes. */
const principalOf = (
  url: string,
  init: { readonly method?: string; readonly headers?: Record<string, string> },
) =>
  Effect.runPromise(
    servicePrincipalMiddleware(
      makeServicePrincipals("k"),
      "gateway-secret",
    )(
      Effect.gen(function* () {
        return HttpServerResponse.text((yield* CurrentPrincipal).kind);
      }),
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`http://localhost${url}`, init)),
      ),
      Effect.flatMap((response) => Effect.promise(() => HttpServerResponse.toWeb(response).text())),
    ),
  );

describe("service principal middleware", () => {
  it("passes everything through only when built without keys (the development exception)", async () => {
    // index.ts refuses to start in this state unless resolveAuthPosture answered `open`.
    expect(await statusOf(undefined, "/v1/workspaces?ownerUserId=u")).toBe(200);
  });

  it("keeps liveness, docs and preflight public", async () => {
    expect(await statusOf("k", "/healthz")).toBe(200);
    expect(await statusOf("k", "/readyz")).toBe(200);
    expect(await statusOf("k", "/openapi.json")).toBe(200);
    expect(await statusOf("k", "/docs/")).toBe(200);
    expect(await statusOf("k", "/v1/workspaces", { method: "OPTIONS" })).toBe(200);
  });

  it("rejects /v1 without a credential and with a wrong key", async () => {
    expect(await statusOf("k", "/v1/workspaces?ownerUserId=u")).toBe(401);
    expect(
      await statusOf("k", "/v1/workspaces", { headers: { authorization: "Bearer nope" } }),
    ).toBe(401);
    expect(await statusOf("k", "/v1/users", { method: "POST" })).toBe(401);
  });

  it("admits a service key by header or by query token", async () => {
    expect(await statusOf("k1,k2", "/v1/users", { headers: { authorization: "Bearer k2" } })).toBe(
      200,
    );
    expect(await statusOf("k1", "/v1/sessions/s/attach?token=k1")).toBe(200);
  });

  it("reads a query token on the session surface only", async () => {
    expect(await statusOf("k1", "/v1/workspaces?ownerUserId=u&token=k1")).toBe(401);
    expect(await statusOf("k1", "/v1/runs/run_1?token=k1")).toBe(401);
    expect(await statusOf("k1", "/v1/workspaces/w/forward?token=k1")).toBe(200);
  });

  it("admits GitHub's signed webhook delivery, and nothing beside it", async () => {
    expect(await statusOf("k", "/v1/github/webhooks", { method: "POST" })).toBe(200);
    expect(await statusOf("k", "/v1/github/webhooks")).toBe(401);
    expect(await statusOf("k", "/v1/github/webhooks/x", { method: "POST" })).toBe(401);
    expect(await statusOf("k", "/v1/github/installations", { method: "POST" })).toBe(401);
  });

  it("lets the session surface through with any bearer for the handler to validate", async () => {
    expect(await statusOf("k", "/v1/sessions/s/output/stream?token=slt_user")).toBe(200);
    expect(
      await statusOf("k", "/v1/sessions", { headers: { authorization: "Bearer slt_user" } }),
    ).toBe(200);
    expect(await statusOf("k", "/v1/workspaces/w/forward?token=slt_user")).toBe(200);
    // …but still nothing without one.
    expect(await statusOf("k", "/v1/sessions/s/output/stream?ownerUserId=u")).toBe(401);
  });

  const gateway = { "x-sealant-gateway-token": "gateway-secret" };

  it("admits the gateway's secret to its own routes, and verifies it", async () => {
    expect(
      await statusOf("k", "/v1/ssh-keys/resolve-principal", { method: "POST", headers: gateway }),
    ).toBe(200);
    expect(await statusOf("k", "/v1/workspaces/w/ssh-target", { headers: gateway })).toBe(200);
    // The run recorder: create and update, nothing else.
    expect(await statusOf("k", "/v1/runs", { method: "POST", headers: gateway })).toBe(200);
    expect(await statusOf("k", "/v1/runs/run_1", { method: "PATCH", headers: gateway })).toBe(200);

    expect(await statusOf("k", "/v1/ssh-keys/resolve-principal", { method: "POST" })).toBe(401);
    // Presence of the header used to be enough to pass the gate.
    expect(
      await statusOf("k", "/v1/ssh-keys/resolve-principal", {
        method: "POST",
        headers: { "x-sealant-gateway-token": "wrong" },
      }),
    ).toBe(401);
  });

  it("holds the gateway's secret to those routes: it is not a service key", async () => {
    expect(await statusOf("k", "/v1/runs", { headers: gateway })).toBe(401);
    expect(await statusOf("k", "/v1/runs/run_1", { headers: gateway })).toBe(401);
    expect(await statusOf("k", "/v1/runs/run_1/timeline", { headers: gateway })).toBe(401);
    expect(await statusOf("k", "/v1/workspaces", { method: "POST", headers: gateway })).toBe(401);
    expect(await statusOf("k", "/v1/workspaces/w", { headers: gateway })).toBe(401);
    expect(await statusOf("k", "/v1/connected-accounts?ownerUserId=u", { headers: gateway })).toBe(
      401,
    );
  });

  it("tells handlers which credential was admitted", async () => {
    expect(await principalOf("/v1/runs", { headers: { authorization: "Bearer k" } })).toBe(
      "service",
    );
    expect(await principalOf("/v1/runs", { method: "POST", headers: gateway })).toBe("gateway");
    expect(await principalOf("/v1/sessions/s?token=slt_user", {})).toBe("bearer");
    // A service key on a gateway route is a service principal, not a gateway.
    expect(
      await principalOf("/v1/runs", {
        method: "POST",
        headers: { ...gateway, authorization: "Bearer k" },
      }),
    ).toBe("service");
  });

  it("refuses a credential over its request budget with the contract's 429 shape", async () => {
    const gate = servicePrincipalMiddleware(makeServicePrincipals("k"), "gateway-secret", {
      window: makeRateWindow(),
      requestsPerMinute: 2,
      now: () => 1_000,
    });
    const send = () =>
      Effect.runPromise(
        gate(ok).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/v1/runs?ownerUserId=u", {
                headers: { authorization: "Bearer k" },
              }),
            ),
          ),
          Effect.map((response) => HttpServerResponse.toWeb(response)),
        ),
      );
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    const body: unknown = await refused.json();
    expect(Schema.decodeUnknownSync(BudgetExceededError)(body)).toMatchObject({
      budget: "principalRequestsPerMinute",
      limit: 2,
      retryAfterSeconds: 60,
    });
  });
});
