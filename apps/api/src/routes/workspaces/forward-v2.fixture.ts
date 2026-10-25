import { createServer, type Server } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import type { ForwardEndpoint } from "@sealant/sdk/internal/forward";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

export const FORWARD_SERVICE_KEY = "slt_forward_v2_service_key";
process.env["SEALANT_SERVICE_KEYS"] = FORWARD_SERVICE_KEY;

export interface ServedCore {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const previousReleaseGate = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!new URL(request.url, "http://localhost").pathname.endsWith("/forward/v2")) {
      return yield* app;
    }
    return HttpServerResponse.jsonUnsafe(
      {
        _tag: "UnauthorizedError",
        message:
          "This control plane requires authentication: present a service key as a bearer token.",
      },
      { status: 401 },
    );
  }),
);

export const serveForwardRoutes = async (options: {
  readonly services: Layer.Layer<never>;
  readonly release: "current" | "previous";
  readonly requestsPerMinute: number;
}): Promise<ServedCore> => {
  const [{ servicePrincipalMiddleware, makeServicePrincipals }, budgets, upgrade, v2, legacy] =
    await Promise.all([
      import("../../services/service-principals.js"),
      import("../../services/budgets.js"),
      import("./forward-upgrade.js"),
      import("./workspaces.forward-v2.js"),
      import("./workspaces.ws.js"),
    ]);
  const routes = (
    options.release === "current"
      ? Layer.mergeAll(legacy.WorkspaceForwardRoute, v2.WorkspaceForwardV2Route)
      : legacy.WorkspaceForwardRoute
  ).pipe(HttpRouter.provideRequest(options.services));
  const gate = servicePrincipalMiddleware(makeServicePrincipals(FORWARD_SERVICE_KEY), undefined, {
    window: budgets.makeRateWindow(),
    requestsPerMinute: options.requestsPerMinute,
  });
  let server: Server | undefined;
  const layer = HttpRouter.serve(routes as Layer.Layer<never, never, HttpRouter.HttpRouter>, {
    middleware: options.release === "current" ? gate : (app) => previousReleaseGate(gate(app)),
  }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(() => (server = upgrade.captureUpgradeHeads(createServer())), {
        port: 0,
      }),
    ),
  );
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const address = server?.address();
  if (typeof address !== "object" || address === null) throw new Error("expected a TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

export const asForwardService = (baseUrl: string, ownerUserId: string): ForwardEndpoint => ({
  baseUrl,
  apiKey: FORWARD_SERVICE_KEY,
  ownerUserId,
});

export const eventually = async (condition: () => boolean, withinMs = 3_000) => {
  const deadline = Date.now() + withinMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${withinMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
