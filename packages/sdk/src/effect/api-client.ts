/**
 * The control-plane wire client — DERIVED, never hand-written.
 *
 * `HttpApiClient.make(ControlPlaneAPI)` generates a fully-typed client directly from the
 * `@sealant/api-contracts` Effect `HttpApi` definition (the single source of truth): requests are
 * encoded and responses decoded by the SAME `Schema`s, and the typed error channel carries the same
 * `TaggedError`s the server declares. No codegen step, no generated artifact, no drift — change the
 * contract and these call sites move with it. (OpenAPI/`buf generate` is reserved for non-TypeScript
 * clients, per SEALANT-PLAN §8.)
 */
import { ControlPlaneAPI } from "@sealant/api-contracts";
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { resolveRequestPriority, type SealantInternalConfig } from "../internal/config.js";
import type { RequestPriority } from "../types.js";
import { CallerTraceState, DirectTraceparent, instrumentClient } from "./trace.js";

/** A per-operation priority; providing it never changes concurrent requests. */
export const CurrentRequestPriority = Context.Reference<RequestPriority | undefined>(
  "@sealant/sdk/CurrentRequestPriority",
  { defaultValue: () => undefined },
);

/** Builds the contract-derived client. Requires an `HttpClient` in context (provided by the layer). */
const buildControlPlaneClient = (config: SealantInternalConfig) => {
  return Effect.map(
    HttpApiClient.make(ControlPlaneAPI, {
      baseUrl: config.baseUrl,
      transformClient: (client: HttpClient.HttpClient) =>
        HttpClient.mapRequestEffect(client, (request) =>
          Effect.gen(function* () {
            const priority = yield* CurrentRequestPriority;
            const traceparent = yield* DirectTraceparent;
            const tracestate = yield* CallerTraceState;
            const prioritized = HttpClientRequest.setHeaders(request, {
              "x-sealant-request-priority": resolveRequestPriority(
                config.requestPriority,
                priority,
              ),
              // Effect's own propagation is off whenever `DirectTraceparent` is set, so this
              // header is the one that reaches the server.
              ...(traceparent === undefined ? {} : { traceparent }),
              ...(tracestate === undefined ? {} : { tracestate }),
            });
            return config.apiKey === undefined
              ? prioritized
              : HttpClientRequest.bearerToken(prioritized, config.apiKey);
          }),
        ),
    }),
    instrumentClient,
  );
};

/** The fully-typed control-plane client, derived from the `@sealant/api-contracts` HttpApi. */
export type ControlPlaneClient = Effect.Success<ReturnType<typeof buildControlPlaneClient>>;

export class SealantApiClient extends Context.Service<SealantApiClient, ControlPlaneClient>()(
  "@sealant/sdk/SealantApiClient",
) {}

/**
 * Live layer: derives the client over a fetch `HttpClient` (the configured `fetch`, else the
 * global one), with an optional bearer token.
 */
export const sealantApiClientLayer = (
  config: SealantInternalConfig,
): Layer.Layer<SealantApiClient> =>
  Layer.effect(SealantApiClient, buildControlPlaneClient(config)).pipe(
    Layer.provide(
      config.fetch === undefined
        ? FetchHttpClient.layer
        : FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, config.fetch)),
          ),
    ),
  );
