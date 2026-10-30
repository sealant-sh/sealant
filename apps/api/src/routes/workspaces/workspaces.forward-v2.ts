import { NodeHttpServerRequest } from "@effect/platform-node";
import {
  FORWARD_V2_SUBPROTOCOL,
  type ForwardBinding,
  type ForwardRefusalReason,
  SessionNotFoundError,
} from "@sealant/api-contracts";
import type { WorkspaceRuntimeInstance } from "@sealant/db";
import {
  FORWARD_BINDING_REFUSALS,
  FORWARD_CONNECT_REASONS,
  FORWARD_OWNER_CAPABILITY,
  type SealantError,
  SealantForwardBindingUnsupported,
  SealantRuntime,
  type SealantTarget,
  SealantUnexpectedError,
  TransportError,
} from "@sealant/workspaces";
import { Data, Effect, Option, Schema } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http";

import { bearerSecretOf, ForwardAdmission } from "../../services/service-principals.js";
import { makeExecutorYesAnswers } from "../executor-answers.js";
import {
  requireSession,
  resolveDaemonInstance,
  type SessionPrincipal,
} from "../sessions/sessions.module.js";
import { checkForward, type ForwardCheck, type ForwardTarget } from "./forward-checks.js";
import { relayBoundedForward } from "./forward-relay.js";
import {
  acceptForwardSocket,
  offersForwardV2,
  refuseDataBeforeReady,
  refuseForward,
  socketClosed,
  upgradeHeadOf,
} from "./forward-upgrade.js";

class ForwardRefused extends Data.TaggedError("ForwardRefused")<{
  readonly reason: ForwardRefusalReason;
  readonly message: string;
}> {}

const refused = (reason: ForwardRefusalReason, message: string) =>
  new ForwardRefused({ reason, message });

const CHECK_REFUSAL = {
  "invalid-target": "invalid-target",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  "owner-required": "owner-required",
  "not-a-person": "not-a-person",
  "not-found": "not-found",
  "workspace-unreadable": "internal",
  internal: "internal",
} as const satisfies Record<ForwardCheck, ForwardRefusalReason>;

const sealantdForwardFailureSchema = Schema.Literals([
  ...FORWARD_CONNECT_REASONS,
  ...FORWARD_BINDING_REFUSALS,
]);
type SealantdForwardFailure = typeof sealantdForwardFailureSchema.Type;

const decodeDaemonDetail = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reason: sealantdForwardFailureSchema })),
);

const OPEN_FAILURE_MESSAGE: Record<
  SealantdForwardFailure | "dial-failed" | "runtime-unreachable" | "binding-unsupported",
  (target: ForwardTarget) => string
> = {
  "connection-refused": ({ host, port }) =>
    `Nothing accepted the connection to ${host}:${port} inside the workspace.`,
  "name-unresolved": ({ host }) => `The name ${host} did not resolve inside the workspace.`,
  "network-unreachable": ({ host, port }) =>
    `No route to ${host}:${port} from inside the workspace.`,
  "dial-timeout": ({ host, port }) =>
    `The connection to ${host}:${port} inside the workspace did not complete in time.`,
  "owner-exited": () => "The session that owns this forward is no longer running.",
  "peer-mismatch": ({ host, port }) =>
    `The process that accepted ${host}:${port} is not part of the requested session.`,
  "binding-unverifiable": ({ host, port }) =>
    `Which process accepted ${host}:${port} could not be established.`,
  "dial-failed": ({ host, port }) =>
    `The workspace runtime could not connect to ${host}:${port}; it reported no cause.`,
  "runtime-unreachable": () =>
    "The workspace runtime could not be reached, or the connection to it was lost.",
  "binding-unsupported": () => "The workspace runtime cannot bind a forward to a session.",
};

const openFailureReason = (
  error: SealantError,
): SealantdForwardFailure | "dial-failed" | "runtime-unreachable" => {
  if (error instanceof TransportError) return "runtime-unreachable";
  if (error instanceof SealantUnexpectedError) return "dial-failed";
  return Option.match(decodeDaemonDetail(error.detailJson), {
    onNone: () => "dial-failed",
    onSome: (detail) => detail.reason,
  });
};

export const DAEMON_HIGH_WATER_BYTES = 256 * 1024;

interface ForwardOwner {
  readonly session: string;
  readonly daemonSessionId: string;
}

const resolveOwner = (input: {
  readonly session: string;
  readonly target: ForwardTarget;
  readonly principal: SessionPrincipal;
  readonly workspaceId: string;
}) =>
  Effect.gen(function* () {
    if (input.target.host === "docker") {
      return yield* refused(
        "invalid-target",
        "A forward bound to a session reaches the workspace's loopback only.",
      );
    }
    const session = yield* requireSession(input.session, input.principal).pipe(
      Effect.mapError((error) =>
        refused(error instanceof SessionNotFoundError ? "not-found" : "internal", error.message),
      ),
    );
    if (session.workspaceId !== input.workspaceId) {
      return yield* refused("not-found", `Session not found: ${input.session}`);
    }
    if (
      session.status === "starting" ||
      (session.status === "running" && session.daemonSessionId === null)
    ) {
      return yield* refused(
        "owner-exited",
        "The session that owns this forward has not started yet.",
      );
    }
    if (session.status !== "running" || session.daemonSessionId === null) {
      return yield* refused("owner-exited", OPEN_FAILURE_MESSAGE["owner-exited"](input.target));
    }
    return {
      session: input.session,
      daemonSessionId: session.daemonSessionId,
    } satisfies ForwardOwner;
  });

const forwardOwnerAnswers = makeExecutorYesAnswers({ ttlMs: 10 * 60_000, max: 1024 });

const runtimeBindsForwards = (instance: WorkspaceRuntimeInstance, target: SealantTarget) =>
  Effect.gen(function* () {
    if (forwardOwnerAnswers.holds(instance.runId)) return true;
    const runtime = yield* SealantRuntime;
    const { supports } = yield* Effect.scoped(
      Effect.flatMap(runtime.connect(target), (daemon) => daemon.capabilities),
    );
    const binds = supports.includes(FORWARD_OWNER_CAPABILITY);
    if (binds) forwardOwnerAnswers.rememberYes(instance.runId);
    return binds;
  });

const openForward = (request: HttpServerRequest.HttpServerRequest, workspaceId: string) =>
  Effect.gen(function* () {
    const url = new URL(request.url, "http://localhost");
    const authorization = request.headers["authorization"];

    const admission = (yield* ForwardAdmission)(
      bearerSecretOf({ authorization, queryToken: url.searchParams.get("token") }),
    );
    if (admission.kind !== "admitted") {
      return yield* refused(admission.kind, admission.message);
    }
    const { target, principal } = yield* checkForward({ authorization, url, workspaceId }).pipe(
      Effect.mapError((failure) => refused(CHECK_REFUSAL[failure.check], failure.message)),
    );
    if (target.protocol !== "tcp") {
      return yield* refused(
        "invalid-target",
        "protocol must be tcp; UDP forwards use the legacy route",
      );
    }
    const session = url.searchParams.get("session");
    const owner =
      session === null
        ? undefined
        : yield* resolveOwner({ session, target, principal, workspaceId });

    const resolved = yield* resolveDaemonInstance(workspaceId).pipe(
      Effect.mapError((error) => refused("internal", error.message)),
    );
    if (resolved === undefined) {
      return yield* refused("workspace-not-ready", "The workspace has no ready runtime.");
    }
    if (resolved.target === undefined) {
      return yield* refused(
        "runtime-untargetable",
        "This control plane has no way to reach the workspace runtime.",
      );
    }

    if (owner !== undefined) {
      const binds = yield* runtimeBindsForwards(resolved.instance, resolved.target).pipe(
        Effect.mapError(() =>
          refused("runtime-unreachable", OPEN_FAILURE_MESSAGE["runtime-unreachable"](target)),
        ),
      );
      if (!binds) {
        return yield* refused(
          "binding-unsupported",
          OPEN_FAILURE_MESSAGE["binding-unsupported"](target),
        );
      }
    }

    const runtime = yield* SealantRuntime;
    const { channel, bound } = yield* runtime
      .openForwardConnection(resolved.target, {
        host: target.host,
        port: target.port,
        highWaterMarkBytes: DAEMON_HIGH_WATER_BYTES,
        ...(owner === undefined ? {} : { ownerSessionId: owner.daemonSessionId }),
      })
      .pipe(
        Effect.mapError((error) => {
          if (error instanceof SealantForwardBindingUnsupported) {
            return refused(
              "binding-unsupported",
              OPEN_FAILURE_MESSAGE["binding-unsupported"](target),
            );
          }
          const reason = openFailureReason(error);
          return refused(reason, OPEN_FAILURE_MESSAGE[reason](target));
        }),
      );
    const binding: ForwardBinding =
      bound.kind === "session" && bound.daemonSessionId === owner?.daemonSessionId
        ? { kind: "session", session: owner.session }
        : { kind: "port" };
    return { channel, binding };
  });

export const WorkspaceForwardV2Route = HttpRouter.add(
  "GET",
  "/v1/workspaces/:workspaceId/forward/v2",
  (request) =>
    Effect.gen(function* () {
      const incoming = NodeHttpServerRequest.toIncomingMessage(request);
      const head = upgradeHeadOf(incoming);
      if (head === undefined) {
        return HttpServerResponse.text(
          `Open this route as a WebSocket with the ${FORWARD_V2_SUBPROTOCOL} subprotocol.`,
          { status: 426, headers: { upgrade: "websocket" } },
        );
      }
      if (!offersForwardV2(request.headers["sec-websocket-protocol"])) {
        return HttpServerResponse.text(`Offer the ${FORWARD_V2_SUBPROTOCOL} subprotocol.`, {
          status: 400,
        });
      }
      const workspaceId = (yield* HttpRouter.params)["workspaceId"];
      if (workspaceId === undefined) {
        return HttpServerResponse.text("missing workspaceId", { status: 400 });
      }

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* acceptForwardSocket(incoming, head);
          // Effect writes the returned response onto the raw socket unless that socket is
          // destroyed, so this returns only once the socket has closed.
          yield* Effect.raceFirst(
            openForward(request, workspaceId).pipe(
              Effect.catchDefect(() =>
                Effect.fail(refused("internal", "The forward failed inside the control plane.")),
              ),
              Effect.matchEffect({
                onFailure: (refusal) => refuseForward(socket, refusal),
                onSuccess: ({ channel, binding }) => {
                  socket.off("message", refuseDataBeforeReady);
                  return relayBoundedForward(socket, binding, channel);
                },
              }),
            ),
            socketClosed(socket),
          );
          return HttpServerResponse.empty({ status: 101 });
        }),
      ).pipe(
        Effect.catchTag("ForwardSocketNeverOpened", () =>
          Effect.succeed(HttpServerResponse.empty()),
        ),
      );
    }),
);
