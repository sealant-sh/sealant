/**
 * Workspace port forwarding as a WebSocket — `GET /v1/workspaces/:workspaceId/forward?port=N`.
 * `?protocol=udp` opens a connected-UDP forward instead of TCP: one WS binary
 * frame is exactly one datagram, both directions — the daemon conduit is
 * message-framed, so nothing on this path re-chunks.
 *
 * The DATA PLANE for reaching a server that listens inside a workspace (a dev
 * server, a database) from outside it. Authenticates ONCE at the upgrade,
 * opens ONE daemon control connection for the socket's lifetime, opens the
 * daemon's TCP forward to `127.0.0.1:port` INSIDE the workspace — BEFORE the
 * upgrade, so nothing listening is a real HTTP 502, not a WS close code — and
 * pumps raw bytes both ways until either side closes. The payload is never
 * inspected and never recorded: a byte pipe, not evidence.
 *
 * Wire protocol:
 *   server → client   binary frame = bytes from the workspace port
 *   server → client   text frame   = JSON `{"t":"end"}` then close (remote closed)
 *   client → server   binary frame = bytes to the workspace port
 *   client → server   text frame   = JSON `{"t":"eof"}` — half-close: no more
 *                     outbound bytes, keep reading. WebSocket has no native
 *                     half-close, and TCP protocols that shutdown(WR) need one.
 *
 * Auth: `Authorization: Bearer` when the client can set headers, else
 * `?token=` (browser WebSocket cannot). Scope: `workspace:exec` — a forward
 * reaches arbitrary in-workspace servers, the same trust as exec. The target
 * host is a CLOSED set: `127.0.0.1` (default) or `docker`, the
 * workspace-scoped dind sidecar's network alias, where inner `docker compose`
 * publishes its ports. Never caller-arbitrary — that would be an
 * in-container SSRF primitive reaching anything the workspace can route to.
 * Registered as a RAW route (HttpApi cannot express an upgrade).
 */
import {
  SessionBadRequestError,
  SessionForbiddenError,
  SessionUnauthorizedError,
  WorkspaceNotFoundError,
} from "@sealant/api-contracts";
import { WorkspaceRepo } from "@sealant/db";
import { SealantRuntime } from "@sealant/workspaces";
import { Effect, Fiber } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import {
  authorize,
  resolveDaemonTarget,
  type SessionPrincipal,
} from "../sessions/sessions.module.js";

/** Uniform 404 on owner or token-workspace mismatch — existence is not leaked. */
const requireWorkspace = (workspaceId: string, principal: SessionPrincipal) =>
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const workspace = yield* workspaces
      .getWorkspaceById(workspaceId)
      .pipe(
        Effect.mapError(
          () => new WorkspaceNotFoundError({ message: `Workspace not found: ${workspaceId}` }),
        ),
      );
    if (
      workspace === undefined ||
      workspace.ownerUserId !== principal.ownerUserId ||
      (principal.workspaceId !== undefined && workspace.id !== principal.workspaceId)
    ) {
      return yield* new WorkspaceNotFoundError({
        message: `Workspace not found: ${workspaceId}`,
      });
    }
    return workspace;
  });

export const WorkspaceForwardRoute = HttpRouter.add(
  "GET",
  "/v1/workspaces/:workspaceId/forward",
  (request) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const workspaceId = params["workspaceId"];
      if (workspaceId === undefined) {
        return HttpServerResponse.text("missing workspaceId", { status: 400 });
      }
      const url = new URL(request.url, "http://localhost");
      const portRaw = url.searchParams.get("port");
      const port = portRaw === null ? Number.NaN : Number(portRaw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return HttpServerResponse.text("port must be an integer in 1..65535", { status: 400 });
      }
      const hostRaw = url.searchParams.get("host") ?? "127.0.0.1";
      const host =
        hostRaw === "127.0.0.1" || hostRaw === "localhost" || hostRaw === "docker"
          ? hostRaw
          : undefined;
      if (host === undefined) {
        return HttpServerResponse.text("host must be one of: 127.0.0.1, localhost, docker", {
          status: 400,
        });
      }
      const protocolRaw = url.searchParams.get("protocol") ?? "tcp";
      const protocol = protocolRaw === "tcp" || protocolRaw === "udp" ? protocolRaw : undefined;
      if (protocol === undefined) {
        return HttpServerResponse.text("protocol must be one of: tcp, udp", { status: 400 });
      }
      const ownerUserId = url.searchParams.get("ownerUserId") ?? undefined;

      // Browser WebSocket clients cannot set headers; accept the bearer via query.
      const headerAuth = request.headers["authorization"];
      const queryToken = url.searchParams.get("token");
      const authorization =
        headerAuth ?? (queryToken === null ? undefined : `Bearer ${queryToken}`);
      const outcome = yield* authorize({
        headers: authorization === undefined ? {} : { authorization },
        requiredScope: "workspace:exec",
        assertedOwnerUserId: ownerUserId,
      }).pipe(
        Effect.flatMap((principal) => requireWorkspace(workspaceId, principal)),
        Effect.map(() => ({ ok: true as const })),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            status:
              error instanceof SessionUnauthorizedError
                ? 401
                : error instanceof SessionForbiddenError
                  ? 403
                  : error instanceof WorkspaceNotFoundError
                    ? 404
                    : error instanceof SessionBadRequestError
                      ? 400
                      : 500,
            message: error.message,
          }),
        ),
      );
      if (!outcome.ok) {
        return HttpServerResponse.text(outcome.message, { status: outcome.status });
      }

      const target = yield* resolveDaemonTarget(workspaceId).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (target === undefined) {
        return HttpServerResponse.text("The workspace runtime is not available.", {
          status: 409,
        });
      }

      const runtime = yield* SealantRuntime;

      // Everything below is scoped to this handler fiber: the client closing
      // the socket interrupts it, and unwinding the scope tears down the
      // daemon connection and with it the forward's socket and pumps.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const daemon = yield* runtime
            .connect(target)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (daemon === undefined) {
            return HttpServerResponse.text("The workspace runtime is not available.", {
              status: 409,
            });
          }
          // Connect INSIDE the workspace before upgrading, like the SSH
          // gateway connects before accepting the channel: a refused connect
          // is an HTTP failure the client can read, not a cryptic WS close.
          const forward = yield* daemon
            .openForward(port, host, protocol)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (forward === undefined) {
            // For UDP there is no handshake to refuse — a 502 here means the
            // daemon could not bind/resolve, not that nothing listens.
            return HttpServerResponse.text(
              `Nothing accepted the connection to ${host}:${port} inside the workspace.`,
              { status: 502 },
            );
          }

          const socket = yield* request.upgrade;
          const write = yield* socket.writer;

          // Workspace → client: drain the channel into binary WS frames.
          // Drain-before-close is load-bearing: `channel.closed` can resolve
          // before the inbound tail is consumed; only iterator completion
          // proves the remote's last bytes were delivered.
          const iterator = forward.channel[Symbol.asyncIterator]();
          const pumpOutput = Effect.gen(function* () {
            for (;;) {
              const next = yield* Effect.promise(() => iterator.next());
              if (next.done === true) {
                break;
              }
              yield* write(next.value);
            }
            yield* write(JSON.stringify({ t: "end" }));
            yield* write(new Socket.CloseEvent(1000, "remote closed"));
          }).pipe(Effect.ignore);
          const outputFiber = yield* Effect.forkScoped(pumpOutput);

          // Client → workspace: binary = bytes to the port; text = control
          // JSON ({"t":"eof"} half-closes outbound, inbound keeps flowing).
          yield* socket
            .runRaw((data) => {
              if (typeof data !== "string") {
                forward.channel.write(data);
                return Effect.void;
              }
              try {
                const frame = JSON.parse(data) as { readonly t?: string };
                if (frame.t === "eof") {
                  forward.channel.end();
                }
              } catch {
                // Unknown text frame — ignored, not fatal.
              }
              return Effect.void;
            })
            .pipe(Effect.ignore);
          yield* Fiber.interrupt(outputFiber);
          // Clean client close: reap the forward now instead of waiting for
          // the connection teardown to do it.
          yield* daemon.closeForward(forward.channelId).pipe(Effect.ignore);
          return HttpServerResponse.empty();
        }),
      );
    }),
);
