import {
  SessionBadRequestError,
  SessionForbiddenError,
  SessionUnauthorizedError,
} from "@sealant/api-contracts";
import { WorkspaceRepo } from "@sealant/db";
import { Data, Effect } from "effect";

import { authorize, type SessionPrincipal } from "../sessions/sessions.module.js";

export type ForwardHost = "127.0.0.1" | "localhost" | "docker";
export type ForwardProtocol = "tcp" | "udp";

export interface ForwardTarget {
  readonly port: number;
  readonly host: ForwardHost;
  readonly protocol: ForwardProtocol;
}

export type ForwardCheck =
  | "invalid-target"
  | "unauthorized"
  | "forbidden"
  | "owner-required"
  | "not-found"
  | "workspace-unreadable"
  | "internal";

export class ForwardCheckFailed extends Data.TaggedError("ForwardCheckFailed")<{
  readonly check: ForwardCheck;
  readonly message: string;
}> {}

const failed = (check: ForwardCheck, message: string) => new ForwardCheckFailed({ check, message });

const parseTarget = (url: URL): ForwardTarget | ForwardCheckFailed => {
  const portRaw = url.searchParams.get("port");
  const port = portRaw === null ? Number.NaN : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return failed("invalid-target", "port must be an integer in 1..65535");
  }
  const host = url.searchParams.get("host") ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "docker") {
    return failed("invalid-target", "host must be one of: 127.0.0.1, localhost, docker");
  }
  const protocol = url.searchParams.get("protocol") ?? "tcp";
  if (protocol !== "tcp" && protocol !== "udp") {
    return failed("invalid-target", "protocol must be one of: tcp, udp");
  }
  return { port, host, protocol };
};

const requireOwnedWorkspace = (workspaceId: string, principal: SessionPrincipal) =>
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const workspace = yield* workspaces
      .getWorkspaceById(workspaceId)
      .pipe(Effect.mapError(() => failed("workspace-unreadable", "Failed to load workspace.")));
    if (
      workspace === undefined ||
      workspace.ownerUserId !== principal.ownerUserId ||
      (principal.workspaceId !== undefined && workspace.id !== principal.workspaceId)
    ) {
      return yield* failed("not-found", `Workspace not found: ${workspaceId}`);
    }
  });

/** The bearer rides `?token=` because a browser WebSocket cannot set headers. */
export const checkForward = (input: {
  readonly authorization: string | undefined;
  readonly url: URL;
  readonly workspaceId: string;
}) =>
  Effect.gen(function* () {
    const target = parseTarget(input.url);
    if (target instanceof ForwardCheckFailed) return yield* target;
    const queryToken = input.url.searchParams.get("token");
    const authorization =
      input.authorization ?? (queryToken === null ? undefined : `Bearer ${queryToken}`);
    const principal = yield* authorize({
      headers: authorization === undefined ? {} : { authorization },
      requiredScope: "workspace:exec",
      assertedOwnerUserId: input.url.searchParams.get("ownerUserId") ?? undefined,
    }).pipe(
      Effect.mapError((error) =>
        failed(
          error instanceof SessionUnauthorizedError
            ? "unauthorized"
            : error instanceof SessionForbiddenError
              ? "forbidden"
              : error instanceof SessionBadRequestError
                ? "owner-required"
                : "internal",
          error.message,
        ),
      ),
    );
    yield* requireOwnedWorkspace(input.workspaceId, principal);
    return { target, principal };
  });
