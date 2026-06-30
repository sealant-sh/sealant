import { z } from "zod";

import type { ControlTarget } from "./control-transport.js";

/*
Routing + per-sandbox authorization resolution (gateway-spec §3.4).

The gateway resolves a *control target* (how to reach a sandbox's sealantd control socket) from the
API — no longer an `ssh://` endpoint to an inner sshd. The username (`sbx-<id>`) is only a routing
hint; the real per-sandbox gate is the API, which authorizes the *principal* (the client key's owner)
against the sandbox before returning a target.
*/

// Exact response contract from API route GET /v1/sandboxes/{sandboxId}/ssh-target.
// Keeping this local schema means the gateway fails loudly if the API shape drifts.
const sandboxSshTargetSchema = z.object({
  sandboxId: z.string().trim().min(1),
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

export type SandboxSshTarget = z.infer<typeof sandboxSshTargetSchema>;

/** Absolute path of the daemon control socket inside a sandbox container. */
export const DEFAULT_CONTROL_SOCKET_PATH = "/run/sealant/control.sock";

// We route users to sandboxes through usernames such as `sbx-<sandboxId>`.
// This parser extracts the sandbox id and applies a conservative character policy
// to avoid passing unexpected strings into downstream routing.
export const parseSandboxIdFromUsername = (
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

  const sandboxId = normalizedUsername.slice(prefixToken.length).trim();

  // Tight character allowlist to avoid weird routing edge cases.
  // Sandbox IDs in this system are UUID-like so this is intentionally restrictive.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(sandboxId)) {
    return undefined;
  }

  return sandboxId;
};

/**
 * Map a resolved API target to a transport `ControlTarget`. Docker adapters reach the daemon socket
 * via `docker exec` into the container (resourceId). A bind-mounted-socket fast path (§2.2) would
 * arrive as an explicit host socketPath, which the API does not advertise yet — so we default to the
 * docker-exec reach.
 */
export const toControlTarget = (target: SandboxSshTarget): ControlTarget => {
  if (target.runtime.adapter !== "docker") {
    throw new Error(
      `Unsupported runtime adapter '${target.runtime.adapter}' for control transport.`,
    );
  }
  return {
    kind: "docker-exec",
    containerId: target.runtime.resourceId,
    socketPath: DEFAULT_CONTROL_SOCKET_PATH,
  };
};

/**
 * Ask the API for the current control target for a sandbox. The gateway token authenticates the
 * gateway as a trusted caller; the principal id scopes *what it may resolve* — the API returns a
 * target only if that principal is authorized for that sandbox (§3.4 step 2).
 */
export const resolveSandboxControlTarget = async (input: {
  readonly apiBaseUrl: string;
  readonly gatewayToken: string;
  readonly principalId: string;
  readonly sandboxId: string;
}): Promise<SandboxSshTarget> => {
  const url = new URL(
    `/v1/sandboxes/${encodeURIComponent(input.sandboxId)}/ssh-target`,
    input.apiBaseUrl,
  );

  const response = await fetch(url, {
    headers: {
      // Shared secret between gateway and API for this internal endpoint.
      "x-sealant-gateway-token": input.gatewayToken,
      // Identifies *who* the client is, so the API can authorize principal x sandbox.
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

  return sandboxSshTargetSchema.parse(payload);
};
