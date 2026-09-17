/**
 * Service principals — trusted products (Mend) that act on behalf of any owner.
 *
 * `SEALANT_SERVICE_KEYS` holds comma-separated bearer secrets. When at least one is configured the
 * control plane is CLOSED: every `/v1` request must authenticate, and a service key is the only
 * credential that may assert an arbitrary `ownerUserId` (the payload/query field every owned
 * endpoint already carries — nothing about the contract shapes changes). The two other
 * credentials keep their narrower meaning: scoped user access tokens authenticate the session
 * surface on their own (a paired phone never holds a service key), and the SSH gateway routes
 * keep their shared secret.
 *
 * Without keys the process refuses to start ({@link resolveAuthPosture}). The one exception is
 * explicit and development-only: `SEALANT_ALLOW_OPEN_API=true` outside `NODE_ENV=production`
 * serves the open pre-auth model, for a control plane on a developer's loopback.
 *
 * Matching is constant-time per key; keys never appear in logs or responses.
 */
import { timingSafeEqual } from "node:crypto";

import { Context, Effect } from "effect";
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

/** How this process authenticates `/v1`, or why it must not start. */
export type AuthPosture =
  | { readonly kind: "closed" }
  | { readonly kind: "open" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Fail closed (CORE-01). Service keys close the control plane. Without them the only way to start
 * is the explicit development exception, and a production process never takes it: a missing
 * secret in a deployment must stop the rollout, not publish every owner's workspaces.
 */
export const resolveAuthPosture = (input: {
  readonly serviceKeys: string | undefined;
  readonly nodeEnv: "development" | "test" | "production";
  readonly allowOpenApi: boolean;
}): AuthPosture => {
  if (parseServiceKeys(input.serviceKeys).length > 0) return { kind: "closed" };
  if (input.nodeEnv === "production") {
    return {
      kind: "refused",
      message: input.allowOpenApi
        ? "SEALANT_SERVICE_KEYS is unset and SEALANT_ALLOW_OPEN_API is not honoured with NODE_ENV=production. Set SEALANT_SERVICE_KEYS to one or more comma-separated secrets and give one to each trusted caller."
        : "SEALANT_SERVICE_KEYS is unset. Set it to one or more comma-separated secrets and give one to each trusted caller (the web app: CORE_API_SERVICE_KEY; an SDK client: apiKey).",
    };
  }
  if (!input.allowOpenApi) {
    return {
      kind: "refused",
      message:
        "SEALANT_SERVICE_KEYS is unset. Set it, or for a control plane on your own loopback set SEALANT_ALLOW_OPEN_API=true (development only: every /v1 route is then served without a credential).",
    };
  }
  return { kind: "open" };
};

/**
 * Who the transport gate admitted (CORE-03). Handlers read it to narrow what a credential may do;
 * none of them widens on it.
 *
 * - `service`: a service key. A trusted product, acting for the owner it names on every call.
 * - `gateway`: the SSH gateway's shared secret. A separate, narrower authority than a service key:
 *   it resolves keys and targets, and records the interactive runs of the sessions it carries.
 *   It can not create workspaces, read records or touch another harness's runs.
 * - `bearer`: some bearer on the session surface; the session handlers validate it themselves.
 * - `open`: the development exception, no credential.
 * - `none`: the default outside a request (unit tests of module functions).
 */
export type RequestPrincipal =
  | { readonly kind: "service" }
  | { readonly kind: "gateway" }
  | { readonly kind: "bearer" }
  | { readonly kind: "open" }
  | { readonly kind: "none" };

export const CurrentPrincipal = Context.Reference<RequestPrincipal>(
  "@sealant/api/CurrentPrincipal",
  { defaultValue: () => ({ kind: "none" }) },
);

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

/**
 * GitHub delivers webhooks with no bearer it could be given. The delivery's HMAC signature is the
 * credential, and the handler verifies it (and answers 503 without a configured secret) before it
 * reads the payload. Exactly this method and path, nothing under it.
 */
const isSignedWebhook = (method: string, pathname: string): boolean =>
  method === "POST" && pathname === "/v1/github/webhooks";

/** The session surface: a scoped user access token is a complete credential here. */
const isSessionSurface = (pathname: string): boolean =>
  pathname.startsWith("/v1/sessions") || /^\/v1\/workspaces\/[^/]+\/forward$/.test(pathname);

/**
 * What the SSH gateway's shared secret reaches: key and target resolution (whose handlers check
 * the secret again), and the run recorder, `POST /v1/runs` and `PATCH /v1/runs/:runId`, where the
 * handlers hold a gateway principal to interactive SSH runs.
 */
export const isGatewayRoute = (method: string, pathname: string): boolean =>
  (method === "POST" && pathname === "/v1/ssh-keys/resolve-principal") ||
  (method === "GET" && /^\/v1\/workspaces\/[^/]+\/ssh-target$/.test(pathname)) ||
  (method === "POST" && (pathname === "/v1/runs" || pathname === "/v1/runs/")) ||
  (method === "PATCH" && /^\/v1\/runs\/[^/]+$/.test(pathname));

const secretMatches = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Transport-level gate. Lets a request through when the deployment is open (development only), the path is public, a
 * service key is presented, a gateway route carries its shared secret, or the session surface
 * carries SOME bearer (the session handlers then validate it as a user access token — and reject
 * it if it is neither a user token nor a service key). Everything else is 401.
 */
export const servicePrincipalMiddleware = (
  principals: ServicePrincipals,
  /** `WORKSPACE_SSH_GATEWAY_TOKEN`; without one no request is a gateway's. */
  gatewayToken?: string,
) =>
  HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const as = (principal: RequestPrincipal) =>
        app.pipe(Effect.provideService(CurrentPrincipal, principal));
      if (!principals.enabled) return yield* as({ kind: "open" });
      const request = yield* HttpServerRequest.HttpServerRequest;
      // CORS preflight carries no credential by design; the cors middleware answers it.
      if (request.method === "OPTIONS") return yield* app;
      const url = new URL(request.url, "http://localhost");
      const pathname = url.pathname;
      if (isPublicPath(pathname)) return yield* app;
      if (isSignedWebhook(request.method, pathname)) return yield* app;
      const secret = bearerSecretOf({
        authorization: request.headers["authorization"],
        // A query string ends up in proxy and access logs. It is read only where a client cannot
        // set a header (browser WebSocket and EventSource on the session surface), so a service
        // key is never accepted from a URL anywhere else.
        queryToken: isSessionSurface(pathname) ? url.searchParams.get("token") : null,
      });
      if (secret !== undefined && principals.matches(secret)) return yield* as({ kind: "service" });
      // The gateway's secret is verified here, not merely noticed: its presence used to be enough
      // to pass the gate, which was sound only while every gateway route re-checked it.
      const presented = request.headers["x-sealant-gateway-token"];
      if (
        typeof presented === "string" &&
        gatewayToken !== undefined &&
        gatewayToken.length > 0 &&
        secretMatches(presented, gatewayToken) &&
        isGatewayRoute(request.method, pathname)
      ) {
        return yield* as({ kind: "gateway" });
      }
      if (secret !== undefined && isSessionSurface(pathname)) return yield* as({ kind: "bearer" });
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

/** How this process authenticates, resolved once; `index.ts` exits on a refusal. */
export const authPosture: AuthPosture = resolveAuthPosture({
  serviceKeys: env.SEALANT_SERVICE_KEYS,
  nodeEnv: env.NODE_ENV,
  allowOpenApi: env.SEALANT_ALLOW_OPEN_API,
});
