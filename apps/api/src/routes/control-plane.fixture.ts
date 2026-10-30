import { once } from "node:events";

import { serve } from "@hono/node-server";
import { ControlPlaneAPI, type RequestRefusal } from "@sealant/api-contracts";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { type HttpApi, HttpApiBuilder, type HttpApiGroup } from "effect/http-api";

import {
  CurrentPrincipal,
  makeServicePrincipals,
  servicePrincipalMiddleware,
  type RequestPrincipal,
} from "../services/service-principals.js";
import { RequestRefusalLive } from "./request-refusal.js";

type ControlPlaneGroups =
  typeof ControlPlaneAPI extends HttpApi.HttpApi<string, infer G> ? G : never;
type ControlPlaneGroupName = ControlPlaneGroups["identifier"];
type ControlPlaneHandlers = HttpApiGroup.ToService<"sealantControlPlaneApi", ControlPlaneGroups>;

interface ControlPlaneOptions<Tested extends ControlPlaneGroupName, Provided> {
  readonly handlers?: Layer.Layer<
    HttpApiGroup.Service<"sealantControlPlaneApi", Tested>,
    never,
    RequestRefusal | HttpRouter.Request.From<"Requires", Provided>
  >;
  /** What the handlers need for each request, as the API provides it (`provideRequest`). */
  readonly provides: Layer.Layer<Provided>;
  readonly groups?: ReadonlyArray<Tested>;
  readonly reached?: (endpoint: string) => void;
}

const controlPlane = <Tested extends ControlPlaneGroupName, Provided>(
  options: ControlPlaneOptions<Tested, Provided>,
) => {
  const tested: ReadonlyArray<string> = options.groups ?? [];
  const spies = Object.values(ControlPlaneAPI.groups)
    .filter((group) => !tested.includes(group.identifier))
    .map((group) =>
      HttpApiBuilder.group(
        ControlPlaneAPI,
        group.identifier,
        (handlers) =>
          // The builder is typed per endpoint name; driven untyped to stub them all without naming
          // each.
          Object.keys(group.endpoints).reduce(
            (acc, endpoint) =>
              (acc as { handle: (n: string, h: unknown) => unknown }).handle(endpoint, () =>
                Effect.sync(() => options.reached?.(endpoint)).pipe(
                  Effect.andThen(Effect.die("not under test")),
                ),
              ),
            handlers as unknown,
          ) as never,
      ),
    );
  const handlers: Layer.Layer<
    ControlPlaneHandlers,
    never,
    RequestRefusal | HttpRouter.Request.From<"Requires", Provided>
  > = Layer.mergeAll(Layer.empty, ...spies, options.handlers ?? Layer.empty);
  return HttpApiBuilder.layer(ControlPlaneAPI).pipe(
    Layer.provide(handlers),
    Layer.provide(RequestRefusalLive),
    HttpRouter.provideRequest(options.provides),
  );
};

/**
 * The real `ControlPlaneAPI` as a web handler, with its request refusal and `principal` as the one
 * the transport gate admitted. `handlers` serves the `groups` under test and must need nothing but
 * the request refusal, so a test that forgets to provide a service does not compile. Every
 * endpoint of every other group is a spy that calls `reached` with its name, then fails as not
 * under test.
 */
export const serveControlPlane = <Tested extends ControlPlaneGroupName = never, Provided = never>(
  options: ControlPlaneOptions<Tested, Provided> & { readonly principal?: RequestPrincipal },
) =>
  HttpRouter.toWebHandler(controlPlane(options).pipe(Layer.provide(HttpServer.layerServices)), {
    middleware: (app) =>
      Effect.provideService(app, CurrentPrincipal, options.principal ?? { kind: "service" }),
  });

/** The same API behind the real transport gate, which admits `serviceKey` as a service. */
export const gateControlPlane = <Tested extends ControlPlaneGroupName, Provided>(
  options: ControlPlaneOptions<Tested, Provided> & { readonly serviceKey: string },
) =>
  HttpRouter.toWebHandler(controlPlane(options).pipe(Layer.provide(HttpServer.layerServices)), {
    middleware: servicePrincipalMiddleware(makeServicePrincipals(options.serviceKey)),
  });

/** A web handler listening on a loopback port, as a client outside the process reaches it. */
export const listenOnLoopback = async (served: {
  readonly handler: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}) => {
  const server = serve({
    fetch: (request) => served.handler(request),
    port: 0,
    hostname: "127.0.0.1",
  });
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("expected a TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await served.dispose();
    },
  };
};
