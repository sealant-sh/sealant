import { createServer, type Server } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { ControlPlaneAPI, PersonId, RequestBudget } from "@sealant/api-contracts";
import { Effect, Exit, Layer, Schema, SchemaAST, Scope } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { makeRateWindow } from "../services/budgets.js";
import {
  admitRawRequest,
  makeServicePrincipals,
  servicePrincipalMiddleware,
} from "../services/service-principals.js";
import { endpointOwnerSource, RequestBudgetLive } from "./request-budget.js";

const hasOwner = (ast: SchemaAST.AST) =>
  SchemaAST.isObjects(ast) && ast.propertySignatures.some((p) => p.name === "ownerUserId");

const api = HttpApi.make("admission")
  .add(
    HttpApiGroup.make("requests")
      .add(
        HttpApiEndpoint.post("write", "/write", {
          payload: Schema.Struct({ ownerUserId: PersonId, value: Schema.String }),
          success: Schema.String,
        }),
      )
      .add(
        HttpApiEndpoint.get("read", "/read", {
          query: { ownerUserId: PersonId },
          success: Schema.String,
        }),
      )
      .add(HttpApiEndpoint.get("unowned", "/unowned", { success: Schema.String })),
  )
  .middleware(RequestBudget);

const serve = async (
  limits: { key?: number; owner?: number; unowned?: number; reserve?: number } = {},
) => {
  const reached: string[] = [];
  const handlers = HttpApiBuilder.group(api, "requests", (h) =>
    h
      .handle("write", ({ payload }) =>
        Effect.sync(() => {
          reached.push(payload.ownerUserId);
          return payload.value;
        }),
      )
      .handle("read", ({ query }) =>
        Effect.sync(() => {
          reached.push(query.ownerUserId);
          return "read";
        }),
      )
      .handle("unowned", () =>
        Effect.sync(() => {
          reached.push("unowned");
          return "unowned";
        }),
      ),
  );
  const raw = HttpRouter.add("POST", "/raw", (request) =>
    Effect.gen(function* () {
      const refusal = yield* admitRawRequest();
      if (refusal !== undefined) return refusal;
      return HttpServerResponse.text(yield* request.text);
    }),
  );
  let server: Server | undefined;
  const routes = Layer.mergeAll(
    raw,
    HttpApiBuilder.layer(api).pipe(Layer.provide(handlers), Layer.provide(RequestBudgetLive)),
  );
  const layer = HttpRouter.serve(routes, {
    middleware: servicePrincipalMiddleware(makeServicePrincipals("key,other-key"), undefined, {
      window: makeRateWindow(),
      requestsPerMinute: limits.key ?? 100,
      ownerRequestsPerMinute: limits.owner ?? 2,
      unownedRequestsPerMinute: limits.unowned ?? 2,
      interactiveReservePercent: limits.reserve ?? 0,
      now: () => 1000,
    }),
  }).pipe(
    Layer.provide(
      NodeHttpServer.layer(() => (server = createServer()), { port: 0, host: "127.0.0.1" }),
    ),
  );
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const address = server?.address();
  if (typeof address !== "object" || address === null) throw new Error("expected TCP address");
  const send = (path: string, body?: string, priority = "normal", key = "key") =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-sealant-request-priority": priority,
      },
      ...(body === undefined ? {} : { body }),
    });
  return { send, reached, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
};

const write = (ownerUserId: string) => JSON.stringify({ ownerUserId, value: "body survived" });

const refusal = async (response: Response, bucket: string, limit: number) => {
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect(await response.json()).toMatchObject({
    _tag: "BudgetExceededError",
    limit,
    retryAfterSeconds: 60,
    refusal: { phase: "before-work", bucket },
  });
};

describe("service request admission over Node HTTP", () => {
  it("keeps each owner and ownerless traffic separate, and preserves a JSON body", async () => {
    const s = await serve();
    try {
      expect(await (await s.send("/write", write("alice"))).json()).toBe("body survived");
      expect((await s.send("/read?ownerUserId=alice")).status).toBe(200);
      await refusal(await s.send("/write", write("alice")), "owner", 2);
      expect((await s.send("/write", write("bob"), "interactive")).status).toBe(200);
      expect((await s.send("/unowned")).status).toBe(200);
      expect((await s.send("/unowned?ownerUserId=alice")).status).toBe(200);
      await refusal(await s.send("/unowned?ownerUserId=unknown"), "unowned", 2);
      expect(s.reached).toEqual(["alice", "alice", "bob", "unowned", "unowned"]);
    } finally {
      await s.close();
    }
  });

  it("never borrows a query owner for a missing, invalid or malformed declared body owner", async () => {
    const s = await serve({ unowned: 1 });
    try {
      expect((await s.send("/unowned")).status).toBe(200);
      for (const body of ["{}", '{"ownerUserId":7}', '{"ownerUserId":"rdm:resource"}', "{"]) {
        await refusal(await s.send("/write?ownerUserId=bob", body), "unowned", 1);
      }
      expect((await s.send("/write?ownerUserId=alice", write("bob"))).status).toBe(200);
      expect(s.reached).toEqual(["unowned", "bob"]);
    } finally {
      await s.close();
    }
  });

  it("leaves reserve for interactive requests at both scope and key, then enforces hard caps", async () => {
    const s = await serve({ key: 10, owner: 5, unowned: 20, reserve: 20 });
    try {
      for (let i = 0; i < 4; i++)
        expect((await s.send("/read?ownerUserId=alice")).status).toBe(200);
      await refusal(await s.send("/read?ownerUserId=alice"), "owner", 4);
      expect((await s.send("/write", write("alice"), "interactive")).status).toBe(200);
      await refusal(await s.send("/write", write("alice"), "interactive"), "owner", 5);
      expect((await s.send("/read?ownerUserId=bob")).status).toBe(200);
      await refusal(await s.send("/read?ownerUserId=bob"), "key", 8);
      expect((await s.send("/write", write("bob"), "interactive")).status).toBe(200);
      expect((await s.send("/write", write("bob"), "interactive")).status).toBe(200);
      await refusal(await s.send("/write", write("bob"), "interactive"), "key", 10);
      expect((await s.send("/write", write("alice"), "normal", "other-key")).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it("admits another owner's interactive sends after one owner's flood fills the normal key allowance", async () => {
    const s = await serve({ key: 20, owner: 10, unowned: 10, reserve: 20 });
    try {
      for (let i = 0; i < 8; i++)
        expect((await s.send("/read?ownerUserId=alice")).status).toBe(200);
      for (let i = 0; i < 8; i++)
        await refusal(await s.send("/read?ownerUserId=alice"), "owner", 8);
      await refusal(await s.send("/read?ownerUserId=alice"), "key", 16);
      await refusal(await s.send("/read?ownerUserId=bob"), "key", 16);

      for (let i = 0; i < 4; i++)
        expect(await (await s.send("/write", write("bob"), "interactive")).json()).toBe(
          "body survived",
        );
      await refusal(await s.send("/write", write("alice"), "interactive"), "key", 20);
      await refusal(await s.send("/write", write("bob"), "interactive"), "key", 20);
      expect(s.reached).toEqual([
        ...Array<string>(8).fill("alice"),
        ...Array<string>(4).fill("bob"),
      ]);
    } finally {
      await s.close();
    }
  });

  it("keeps disabled budgets off and never turns a tiny normal allowance into an unlimited one", async () => {
    const unlimited = await serve({ key: 0, owner: 0, unowned: 0, reserve: 99 });
    try {
      for (let i = 0; i < 5; i++)
        expect((await unlimited.send("/read?ownerUserId=alice")).status).toBe(200);
    } finally {
      await unlimited.close();
    }
    const tiny = await serve({ key: 1, owner: 1, reserve: 99 });
    try {
      expect((await tiny.send("/read?ownerUserId=alice")).status).toBe(200);
      await refusal(await tiny.send("/read?ownerUserId=bob"), "key", 1);
    } finally {
      await tiny.close();
    }
  });

  it("admits raw stdin as ownerless without consuming its bytes and protects unknown paths by key", async () => {
    const s = await serve({ key: 4, unowned: 1 });
    try {
      expect(await (await s.send("/raw?ownerUserId=alice", "stdin\nbytes")).text()).toBe(
        "stdin\nbytes",
      );
      await refusal(await s.send("/raw", "other"), "unowned", 1);
      expect((await s.send("/does-not-exist")).status).toBe(404);
      expect((await s.send("/does-not-exist")).status).toBe(404);
      await refusal(await s.send("/does-not-exist"), "key", 4);
    } finally {
      await s.close();
    }
  });
});

describe("control-plane admission declaration", () => {
  it("declares typed 429 everywhere and recognizes every current owner schema", () => {
    for (const group of Object.values(ControlPlaneAPI.groups))
      for (const endpoint of Object.values(group.endpoints)) {
        expect(endpoint.middlewares.has(RequestBudget), endpoint.name).toBe(true);
        const schemas = [...endpoint.payload.values()].flatMap((payload) => payload.schemas);
        // Non-object request parts currently contain no person fields. Fail on a new structural
        // shape so admission must be taught how to find its authoritative owner.
        for (const schema of [
          ...schemas,
          ...(endpoint.query === undefined ? [] : [endpoint.query]),
        ]) {
          expect(["Objects", "String"], endpoint.name).toContain(schema.ast["_tag"]);
        }
        const expected = schemas.some((s) => hasOwner(s.ast))
          ? "body"
          : endpoint.query !== undefined && hasOwner(endpoint.query.ast)
            ? "query"
            : "unowned";
        expect(endpointOwnerSource(endpoint), endpoint.name).toBe(expected);
      }
  });
});
