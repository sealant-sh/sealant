/**
 * Service principals — trusted products (Mend) that act on behalf of any owner.
 *
 * `SEALANT_SERVICE_KEYS` holds comma-separated bearer secrets. When at least one is configured the
 * control plane is CLOSED: every `/v1` request must authenticate, and a service key is the only
 * credential that may assert an arbitrary `ownerUserId` (the payload/query field every owned
 * endpoint already carries — nothing about the contract shapes changes). The two other
 * credentials keep their narrower meaning: scoped user access tokens authenticate the session
 * surface on their own (a paired phone never holds a service key), and the SSH gateway routes
 * keep their shared secret. Without keys the API stays the open, loopback-only pre-auth model.
 *
 * Matching is constant-time per key; keys never appear in logs or responses.
 */
import { timingSafeEqual } from "node:crypto";

import { Effect } from "effect";
import {
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
  type HttpServerResponse as HttpServerResponseType,
} from "effect/unstable/http";

import { env } from "../runtime-env.js";

export interface ServicePrincipals {
  /** True when the deployment requires authentication on the control plane. */
  readonly enabled: boolean;
  /** Whether the presented bearer secret is one of the configured service keys. */
  readonly matches: (secret: string) => boolean;
}

export const parseServiceKeys = (raw: string | undefined): ReadonlyArray<string> =>
  raw === undefined
    ? []
    : raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

export const makeServicePrincipals = (raw: string | undefined): ServicePrincipals => {
  const keys = parseServiceKeys(raw).map((key) => Buffer.from(key, "utf8"));
  return {
    enabled: keys.length > 0,
    matches: (secret) => {
      const candidate = Buffer.from(secret, "utf8");
      // Compare against EVERY key so the time taken does not reveal which one (if any) matched.
      let matched = false;
      for (const key of keys) {
        if (key.length === candidate.length && timingSafeEqual(key, candidate)) {
          matched = true;
        }
      }
      return matched;
    },
  };
};

/** The bearer secret a request presents: the `Authorization` header, or `?token=` for WebSockets. */
export const bearerSecretOf = (input: {
  readonly authorization: string | undefined;
  readonly queryToken: string | null;
}): string | undefined => {
  const header = input.authorization?.trim();
  if (header !== undefined && header.length > 0) {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match?.[1]?.trim();
  }
  const token = input.queryToken?.trim();
  return token === undefined || token.length === 0 ? undefined : token;
};

/** Routes that never require a credential: liveness, readiness and the generated docs. */
const isPublicPath = (pathname: string): boolean =>
  pathname === "/" ||
  pathname === "/healthz" ||
  pathname === "/readyz" ||
  pathname === "/openapi.json" ||
  pathname === "/docs" ||
  pathname.startsWith("/docs/");

/** The session surface: a scoped user access token is a complete credential here. */
const isSessionSurface = (pathname: string): boolean =>
  pathname.startsWith("/v1/sessions") || /^\/v1\/workspaces\/[^/]+\/forward$/.test(pathname);

/** The gateway routes carry their own shared secret; the handlers validate it. */
const isGatewayRoute = (pathname: string, request: HttpServerRequest.HttpServerRequest): boolean =>
  (pathname === "/v1/ssh-keys/resolve-principal" ||
    /^\/v1\/workspaces\/[^/]+\/ssh-target$/.test(pathname)) &&
  typeof request.headers["x-sealant-gateway-token"] === "string";

/**
 * Transport-level gate. Lets a request through when the deployment is open, the path is public, a
 * service key is presented, a gateway route carries its shared secret, or the session surface
 * carries SOME bearer (the session handlers then validate it as a user access token — and reject
 * it if it is neither a user token nor a service key). Everything else is 401.
 */
export const servicePrincipalMiddleware = (principals: ServicePrincipals) =>
  HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      if (!principals.enabled) return yield* app;
      const request = yield* HttpServerRequest.HttpServerRequest;
      // CORS preflight carries no credential by design; the cors middleware answers it.
      if (request.method === "OPTIONS") return yield* app;
      const url = new URL(request.url, "http://localhost");
      const pathname = url.pathname;
      if (isPublicPath(pathname)) return yield* app;
      if (isGatewayRoute(pathname, request)) return yield* app;
      const secret = bearerSecretOf({
        authorization: request.headers["authorization"],
        queryToken: url.searchParams.get("token"),
      });
      if (secret !== undefined && (principals.matches(secret) || isSessionSurface(pathname))) {
        return yield* app;
      }
      const response: HttpServerResponseType.HttpServerResponse = HttpServerResponse.jsonUnsafe(
        {
          _tag: "UnauthorizedError",
          message:
            secret === undefined
              ? "This control plane requires authentication: present a service key as a bearer token."
              : "Unknown service key.",
        },
        { status: 401 },
      );
      return response;
    }),
  );

/** The deployment's service principals, resolved once from `SEALANT_SERVICE_KEYS`. */
export const servicePrincipals: ServicePrincipals = makeServicePrincipals(env.SEALANT_SERVICE_KEYS);
