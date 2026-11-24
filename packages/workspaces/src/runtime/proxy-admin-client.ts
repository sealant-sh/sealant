/**
 * The client of an egress proxy's admin socket (`/run/sealant/proxy-admin.sock` inside
 * `<name>-proxy`, on the control directory's `<name>-proxy` subpath, which the workspace never
 * mounts). HTTP/1.1 over a Unix socket, one request per connection, every body framed with
 * `Content-Length` (the proxy refuses chunked bodies).
 *
 * The wire types mirror `sealant-egress-proxy` exactly (`admin.rs`, `policy.rs`, `state.rs`,
 * camelCase): `PUT /v1/policy` takes a `ProxyPolicyDocument`, `POST /v1/revoke` a
 * `ProxyRevokeRequest` and answers only once every matching stream is closed, `POST
 * /v1/heartbeat` renews the disconnected lease, and `GET /v1/health` reports readiness. Requests
 * carry secret values and the CA's private key; nothing here logs a body.
 */
import { request } from "node:http";

import type {
  ProxyHealth,
  ProxyHeartbeat,
  ProxyPolicyApplied,
  ProxyPolicyDocument,
  ProxyRevoked,
  ProxyRevokeRequest,
} from "./egress-proxy-types.js";

export type {
  ProxyAllowHost,
  ProxyBrokeredSecret,
  ProxyHealth,
  ProxyHeartbeat,
  ProxyPolicyApplied,
  ProxyPolicyDocument,
  ProxyRevoked,
  ProxyRevokeRequest,
} from "./egress-proxy-types.js";

/** The proxy could not be reached, or did not answer within the bound: nothing is known. */
export class ProxyAdminUnreachableError extends Error {
  public override readonly name = "ProxyAdminUnreachableError";
}

/**
 * The proxy answered and refused (`{ error, message }`): `invalid_policy`, `invalid_revoke`,
 * `watermark_rollback` (409), `not_initialized` (503), `close_unconfirmed` (500), and the like.
 */
export class ProxyAdminRefusedError extends Error {
  public override readonly name = "ProxyAdminRefusedError";
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`The egress proxy refused (${String(status)} ${code}): ${message}`);
  }
}

export interface ProxyAdminClient {
  readonly health: () => Promise<ProxyHealth>;
  readonly putPolicy: (document: ProxyPolicyDocument) => Promise<ProxyPolicyApplied>;
  readonly revoke: (revocation: ProxyRevokeRequest) => Promise<ProxyRevoked>;
  readonly heartbeat: (revocationWatermark: number) => Promise<ProxyHeartbeat>;
}

/** The proxy's own bound on reading a request is 30 s; a revoke waits up to 5 s for closes. */
export const PROXY_ADMIN_TIMEOUT_MS = 15_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = <T>(
  body: Record<string, unknown>,
  name: string,
  check: (value: unknown) => value is T,
): T => {
  const value = body[name];
  if (!check(value))
    throw new ProxyAdminUnreachableError(`the egress proxy answered without ${name}`);
  return value;
};
const isNumber = (value: unknown): value is number => typeof value === "number";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isString = (value: unknown): value is string => typeof value === "string";

const call = (
  socketPath: string,
  method: "GET" | "PUT" | "POST",
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      {
        socketPath,
        method,
        path,
        agent: false,
        headers: {
          host: "proxy-admin",
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": String(payload.length) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", (error) => reject(new ProxyAdminUnreachableError(error.message)));
        res.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new ProxyAdminUnreachableError("the egress proxy answered with no JSON body"));
            return;
          }
          const status = res.statusCode ?? 0;
          if (!isRecord(parsed)) {
            reject(new ProxyAdminUnreachableError("the egress proxy answered with no JSON object"));
          } else if (status === 200) {
            resolve(parsed);
          } else {
            reject(
              new ProxyAdminRefusedError(
                status,
                isString(parsed["error"]) ? parsed["error"] : "unknown",
                isString(parsed["message"]) ? parsed["message"] : "no message",
              ),
            );
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new ProxyAdminUnreachableError(
          `the egress proxy did not answer ${method} ${path} within ${String(timeoutMs)} ms`,
        ),
      );
    });
    req.on("error", (error) =>
      reject(
        error instanceof ProxyAdminUnreachableError
          ? error
          : new ProxyAdminUnreachableError(`the egress proxy admin socket: ${error.message}`),
      ),
    );
    req.end(payload);
  });

export const createProxyAdminClient = (
  socketPath: string,
  options: { readonly timeoutMs?: number } = {},
): ProxyAdminClient => {
  const timeoutMs = options.timeoutMs ?? PROXY_ADMIN_TIMEOUT_MS;
  return {
    health: async () => {
      const body = await call(socketPath, "GET", "/v1/health", undefined, timeoutMs);
      const mode = body["mode"];
      const policyHash = body["policyHash"];
      return {
        initialized: field(body, "initialized", isBoolean),
        ...(mode === "standard" || mode === "restricted" ? { mode } : {}),
        ...(isString(policyHash) ? { policyHash } : {}),
        revocationWatermark: field(body, "revocationWatermark", isNumber),
        activeConnections: field(body, "activeConnections", isNumber),
        leaseRemainingMs: field(body, "leaseRemainingMs", isNumber),
        leaseExpired: field(body, "leaseExpired", isBoolean),
        resyncRequired: field(body, "resyncRequired", isBoolean),
      };
    },
    putPolicy: async (document) => {
      const body = await call(socketPath, "PUT", "/v1/policy", document, timeoutMs);
      return {
        policyHash: field(body, "policyHash", isString),
        revocationWatermark: field(body, "revocationWatermark", isNumber),
        closed: field(body, "closed", isNumber),
      };
    },
    revoke: async (revocation) => {
      const body = await call(socketPath, "POST", "/v1/revoke", revocation, timeoutMs);
      return {
        revocationWatermark: field(body, "revocationWatermark", isNumber),
        closed: field(body, "closed", isNumber),
      };
    },
    heartbeat: async (revocationWatermark) => {
      const body = await call(
        socketPath,
        "POST",
        "/v1/heartbeat",
        { revocationWatermark },
        timeoutMs,
      );
      return {
        resyncRequired: field(body, "resyncRequired", isBoolean),
        leaseRemainingMs: field(body, "leaseRemainingMs", isNumber),
        revocationWatermark: field(body, "revocationWatermark", isNumber),
      };
    },
  };
};
