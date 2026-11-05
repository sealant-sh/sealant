import { RequestBudget } from "@sealant/api-contracts";
import { Effect, Layer, SchemaAST } from "effect";
import { HttpServerRequest } from "effect/http";
import type { HttpApiEndpoint } from "effect/http-api";

import { RequestOwnerAdmission, requestBudgetResponse } from "../services/service-principals.js";

const declaresOwner = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isObjects(ast) && ast.propertySignatures.some((field) => field.name === "ownerUserId");

/** Only a field declared by this endpoint can select an owner's request bucket. */
export const endpointOwnerSource = (
  endpoint: HttpApiEndpoint.Top,
): "body" | "query" | "unowned" => {
  for (const payload of endpoint.payload.values()) {
    if (payload.schemas.some((schema) => declaresOwner(schema.ast))) return "body";
  }
  return endpoint.query !== undefined && declaresOwner(endpoint.query.ast) ? "query" : "unowned";
};

const ownerField = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("ownerUserId" in value)) return undefined;
  return typeof value.ownerUserId === "string" ? value.ownerUserId : undefined;
};

/** Runs before decoding and handlers; JSON is cached by the real HTTP request implementation. */
export const RequestBudgetLive: Layer.Layer<RequestBudget> = Layer.succeed(
  RequestBudget,
  (httpEffect, { endpoint }) => {
    const source = endpointOwnerSource(endpoint);
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      let ownerUserId: string | undefined;
      if (source === "query") {
        ownerUserId =
          new URL(request.url, "http://localhost").searchParams.get("ownerUserId") ?? undefined;
      } else if (source === "body") {
        const mediaType = (request.headers["content-type"] ?? "application/json")
          .split(";")[0]
          ?.trim()
          .toLowerCase();
        if (
          mediaType !== undefined &&
          endpoint.payload.get(mediaType)?.encoding["_tag"] === "Json"
        ) {
          ownerUserId = ownerField(yield* request.json.pipe(Effect.orElseSucceed(() => undefined)));
        }
      }
      const error = (yield* RequestOwnerAdmission)(ownerUserId);
      if (error !== undefined) return requestBudgetResponse(error);
      return yield* httpEffect;
    });
  },
);
