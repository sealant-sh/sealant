import { z } from "zod";

import type { ControlTarget } from "./control-transport.js";

/*
Routing + per-workspace authorization resolution (gateway-spec §3.4).

The gateway resolves a *control target* (how to reach a workspace's sealantd control socket) from the
API — no longer an `ssh://` endpoint to an inner sshd. The username (`ws-<id>`) is only a routing
hint; the real per-workspace gate is the API, which authorizes the *principal* (the client key's owner)
against the workspace before returning a target.
*/

// Exact response contract from API route GET /v1/workspaces/{workspaceId}/ssh-target.
// Keeping this local schema means the gateway fails loudly if the API shape drifts.
const workspaceSshTargetSchema = z.object({
  workspaceId: z.string().trim().min(1),
  attemptId: z.string().trim().min(1),
  runtime: z.object({
    adapter: z.enum(["docker", "k8s", "k3s"]),
    resourceId: z.string().trim().min(1),
    reference: z.string().trim().min(1),
    status: z.enum(["pending", "running", "ready", "failed", "stopped"]),
    endpoint: z.string().trim().min(1),
  }),
});

const messageResponseSchema = z.object({
  message: z.string().trim().min(1),
});

export type WorkspaceSshTarget = z.infer<typeof workspaceSshTargetSchema>;

/** Absolute path of the daemon control socket inside a workspace container. */
export const DEFAULT_CONTROL_SOCKET_PATH = "/run/sealant/control.sock";

// We route users to workspaces through usernames such as `ws-<workspaceId>`.
// This parser extracts the workspace id and applies a conservative character policy
// to avoid passing unexpected strings into downstream routing.
export const parseWorkspaceIdFromUsername = (
  username: string,
  prefix: string,
): string | undefined => {
  const normalizedPrefix = prefix.trim();
  const normalizedUsername = username.trim();
  const prefixToken = `${normalizedPrefix}-`;

  if (
    normalizedPrefix.length === 0 ||
    normalizedUsername.length === 0 ||
    !normalizedUsername.startsWith(prefixToken)
  ) {
    return undefined;
  }

  const workspaceId = normalizedUsername.slice(prefixToken.length).trim();

  // Tight character allowlist to avoid weird routing edge cases.
  // Workspace IDs in this system are UUID-like so this is intentionally restrictive.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(workspaceId)) {
    return undefined;
  }

  return workspaceId;
};

const UNIX_ENDPOINT_PREFIX = "unix://";

/**
 * Map a resolved API target to a transport `ControlTarget`, driven by the runtime `endpoint`:
 *  - `unix://<host path>` (§2.2): the adapter bind-mounted the daemon socket to a host path the
 *    gateway can `net.connect` directly — NO Docker access needed. Preferred.
 *  - anything else (`docker-exec://…`, §2.1): bridge in with `docker exec … socat` into the container.
 */
export const toControlTarget = (target: WorkspaceSshTarget): ControlTarget => {
  if (target.runtime.adapter !== "docker") {
    throw new Error(
      `Unsupported runtime adapter '${target.runtime.adapter}' for control transport.`,
    );
  }
  const endpoint = target.runtime.endpoint.trim();
  if (endpoint.startsWith(UNIX_ENDPOINT_PREFIX)) {
    return { kind: "unix-socket", socketPath: endpoint.slice(UNIX_ENDPOINT_PREFIX.length) };
  }
  return {
    kind: "docker-exec",
    containerId: target.runtime.resourceId,
    socketPath: DEFAULT_CONTROL_SOCKET_PATH,
  };
};

/**
 * Ask the API for the current control target for a workspace. The gateway token authenticates the
 * gateway as a trusted caller; the principal id scopes *what it may resolve* — the API returns a
 * target only if that principal is authorized for that workspace (§3.4 step 2).
 */
export const resolveWorkspaceControlTarget = async (input: {
  readonly apiBaseUrl: string;
  readonly gatewayToken: string;
  readonly principalId: string;
  readonly workspaceId: string;
}): Promise<WorkspaceSshTarget> => {
  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/ssh-target`,
    input.apiBaseUrl,
  );

  const response = await fetch(url, {
    headers: {
      // Shared secret between gateway and API for this internal endpoint.
      "x-sealant-gateway-token": input.gatewayToken,
      // Identifies *who* the client is, so the API can authorize principal x workspace.
      "x-sealant-principal-id": input.principalId,
    },
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // Prefer API-provided human-readable error messages to simplify operator debugging.
    const parsedError = messageResponseSchema.safeParse(payload);
    throw new Error(
      parsedError.success
        ? parsedError.data.message
        : `Control target resolution failed with status ${response.status}.`,
    );
  }

  return workspaceSshTargetSchema.parse(payload);
};
