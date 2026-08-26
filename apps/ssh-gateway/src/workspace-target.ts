import {
  describeUnaddressableRuntimeInstance,
  sealantTargetForRuntimeInstance,
  type SealantTarget,
  type SealantTargetDerivationOptions,
} from "@sealant/workspaces";
import { z } from "zod";

/*
Routing + per-workspace authorization resolution (gateway-spec §3.4).

The gateway resolves a *control target* (how to reach a workspace's sealantd control socket) from the
API — no longer an `ssh://` endpoint to an inner sshd. The username (`ws-<id>`) is only a routing
hint; the real per-workspace gate is the API, which authorizes the *principal* (the client key's owner)
against the workspace before returning a target.

Target derivation and the transport itself live in `@sealant/workspaces` (`sealantd/target.ts`,
`sealantd/plain-transport.ts`) — one home per concern, shared with the worker and API, so a new
runtime family is added there once and the gateway follows for free.
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

/** What the gateway process has for reaching each runtime family. */
export type ControlTargetOptions = SealantTargetDerivationOptions;

/**
 * Map a resolved API target to a transport `SealantTarget` via the canonical derivation in
 * `@sealant/workspaces`. The gateway keeps throw-on-unaddressable semantics: an SSH connection
 * with no reachable control transport must fail loudly with the operator-actionable reason.
 */
export const toControlTarget = (
  target: WorkspaceSshTarget,
  options: ControlTargetOptions = {},
): SealantTarget => {
  const derived = sealantTargetForRuntimeInstance(target.runtime, options);
  if (derived === undefined) {
    throw new Error(
      `Cannot open a control transport: ${describeUnaddressableRuntimeInstance(target.runtime, options)}.`,
    );
  }
  return derived;
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
