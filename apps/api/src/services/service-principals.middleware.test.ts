import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { makeServicePrincipals, servicePrincipalMiddleware } from "./service-principals.js";

const ok = Effect.succeed(HttpServerResponse.text("ok"));

const statusOf = (
  keys: string | undefined,
  url: string,
  init: { readonly method?: string; readonly headers?: Record<string, string> } = {},
) =>
  Effect.runPromise(
    servicePrincipalMiddleware(makeServicePrincipals(keys))(ok).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`http://localhost${url}`, init)),
      ),
      Effect.map((response) => response.status),
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

  it("lets gateway routes through only when they carry the gateway header", async () => {
    expect(
      await statusOf("k", "/v1/ssh-keys/resolve-principal", {
        method: "POST",
        headers: { "x-sealant-gateway-token": "g" },
      }),
    ).toBe(200);
    expect(await statusOf("k", "/v1/ssh-keys/resolve-principal", { method: "POST" })).toBe(401);
    expect(
      await statusOf("k", "/v1/workspaces/w/ssh-target", {
        headers: { "x-sealant-gateway-token": "g" },
      }),
    ).toBe(200);
  });
});
