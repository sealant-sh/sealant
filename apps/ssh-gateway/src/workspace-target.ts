import { runtimeAdapterIdSchema } from "@sealant/validators";
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
    adapter: runtimeAdapterIdSchema,
    resourceId: z.string().trim().min(1),
    reference: z.string().trim().min(1),
    status: z.enum(["pending", "running", "ready", "failed", "stopped"]),
    endpoint: z.string().trim().min(1),
  }),
  // Who every session of this workspace runs as, always stated: a Linux user, or null for root. An
  // API that does not state it (one from before SSH users) fails this parse, and the session is
  // refused: silence is never read as root.
  sessionUser: z.string().trim().min(1).nullable(),
  // The key fingerprint the gateway named, echoed once the API found it still registered.
  sshKeyFingerprint: z.string().trim().min(1).optional(),
});

const messageResponseSchema = z.object({
  message: z.string().trim().min(1),
});

export type WorkspaceSshTarget = z.infer<typeof workspaceSshTargetSchema>;

/** How long one target lookup may take before the channel that asked is refused. */
const TARGET_TIMEOUT_MS = 10_000;

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
 * The API refused the target outright (401): the principal is not the workspace's, or the key the
 * connection logged in with is no longer registered. Nothing further on that connection is
 * authorized, so the gateway ends it.
 */
export class WorkspaceTargetUnauthorizedError extends Error {
  override readonly name = "WorkspaceTargetUnauthorizedError";
}

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
  /**
   * The fingerprint of the registered key the connection logged in with; the API answers only
   * while it is still the principal's. Undefined for a key from the gateway's allowlist file.
   */
  readonly keyFingerprint?: string;
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
      // This gateway runs a workspace's sessions as its user; the API answers a workspace with a
      // user only to a gateway that says so.
      "x-sealant-gateway-ssh-user": "1",
      ...(input.keyFingerprint === undefined
        ? {}
        : { "x-sealant-ssh-key-fingerprint": input.keyFingerprint }),
    },
    // Asked for every session channel: an API that does not answer refuses the channel in time,
    // never holds it open.
    signal: AbortSignal.timeout(TARGET_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // Prefer API-provided human-readable error messages to simplify operator debugging.
    const parsedError = messageResponseSchema.safeParse(payload);
    const message = parsedError.success
      ? parsedError.data.message
      : `Control target resolution failed with status ${response.status}.`;
    throw response.status === 401
      ? new WorkspaceTargetUnauthorizedError(message)
      : new Error(message);
  }

  const target = workspaceSshTargetSchema.parse(payload);
  if (input.keyFingerprint !== undefined && target.sshKeyFingerprint !== input.keyFingerprint) {
    // An API from before key checks answers without looking at the key: a removed key would keep
    // opening channels, so its answer is refused.
    throw new Error(
      "The API did not check this connection's SSH key: upgrade the API with the gateway.",
    );
  }
  return target;
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
