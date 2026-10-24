import { NodeHttpServerRequest } from "@effect/platform-node";
import { FORWARD_V2_SUBPROTOCOL, type ForwardRefusalReason } from "@sealant/api-contracts";
import {
  type SealantError,
  SealantRuntime,
  SealantUnexpectedError,
  TransportError,
} from "@sealant/workspaces";
import { Data, Duration, Effect, Option, Schema } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http";

import { bearerSecretOf, ForwardAdmission } from "../../services/service-principals.js";
import { resolveDaemonInstance } from "../sessions/sessions.module.js";
import { checkForward, type ForwardCheck, type ForwardTarget } from "./forward-checks.js";
import {
  acceptForwardSocket,
  offersForwardV2,
  refuseForward,
  relayForward,
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
  "not-found": "not-found",
  "workspace-unreadable": "internal",
  internal: "internal",
} as const satisfies Record<ForwardCheck, ForwardRefusalReason>;

const sealantdForwardFailureSchema = Schema.Literals([
  "connection-refused",
  "name-unresolved",
  "network-unreachable",
  "dial-timeout",
  "owner-exited",
  "peer-mismatch",
  "binding-unverifiable",
]);
type SealantdForwardFailure = typeof sealantdForwardFailureSchema.Type;

const decodeDaemonDetail = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reason: sealantdForwardFailureSchema })),
);

const OPEN_FAILURE_MESSAGE: Record<
  SealantdForwardFailure | "dial-failed" | "runtime-unreachable",
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
  "runtime-unreachable": () => "The connection to the workspace runtime was lost.",
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

const CLOSE_FORWARD_REPLY_BOUND = Duration.seconds(2);

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
    const target = yield* checkForward({ authorization, url, workspaceId }).pipe(
      Effect.mapError((failure) => refused(CHECK_REFUSAL[failure.check], failure.message)),
    );
    if (target.protocol !== "tcp") {
      return yield* refused(
        "invalid-target",
        "protocol must be tcp; UDP forwards use the legacy route",
      );
    }

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

    const runtime = yield* SealantRuntime;
    const daemon = yield* runtime
      .connect(resolved.target)
      .pipe(
        Effect.mapError(() =>
          refused("runtime-unreachable", "The workspace runtime did not accept a connection."),
        ),
      );
    const forward = yield* daemon.openForward(target.port, target.host, "tcp").pipe(
      Effect.mapError((error) => {
        const reason = openFailureReason(error);
        return refused(reason, OPEN_FAILURE_MESSAGE[reason](target));
      }),
    );
    yield* Effect.addFinalizer(() =>
      daemon
        .closeForward(forward.channelId)
        .pipe(Effect.timeoutOption(CLOSE_FORWARD_REPLY_BOUND), Effect.ignore),
    );
    return forward.channel;
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
                onSuccess: (channel) => relayForward(socket, { kind: "port" }, channel),
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
