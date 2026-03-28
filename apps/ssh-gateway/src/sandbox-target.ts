import { z } from "zod";

// Exact response contract from API route GET /v1/sandboxes/{sandboxId}/ssh-target.
// Keeping this local schema means gateway fails loudly if API shape drifts.
const sandboxSshTargetSchema = z.object({
  sandboxId: z.string().trim().min(1),
  attemptId: z.string().trim().min(1),
  runtime: z.object({
    adapter: z.enum(["docker", "k8s", "k3s"]),
    resourceId: z.string().trim().min(1),
    reference: z.string().trim().min(1),
    status: z.enum(["pending", "running", "failed", "stopped"]),
    endpoint: z.string().trim().min(1),
  }),
});

const messageResponseSchema = z.object({
  message: z.string().trim().min(1),
});

export type SandboxSshTarget = z.infer<typeof sandboxSshTargetSchema>;

export interface ParsedSshEndpoint {
  readonly user: string;
  readonly host: string;
  readonly port: number;
}

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

// Runtime metadata stores endpoints as URIs so we parse once here and hand typed
// connection parameters to the gateway SSH client.
export const parseSshEndpoint = (endpoint: string): ParsedSshEndpoint => {
  const normalized = endpoint.trim();

  if (!normalized.startsWith("ssh://")) {
    throw new Error(`Invalid runtime endpoint '${endpoint}'. Expected ssh:// URI.`);
  }

  let parsed: URL;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid runtime endpoint '${endpoint}'.`);
  }

  if (parsed.hostname.length === 0) {
    throw new Error(`Invalid runtime endpoint '${endpoint}'. Missing host.`);
  }

  return {
    // Runtime metadata can omit user/port; default to OpenSSH conventions.
    user: parsed.username.length === 0 ? "root" : parsed.username,
    host: parsed.hostname,
    port: parsed.port.length === 0 ? 22 : Number(parsed.port),
  };
};

// Ask the API for the current internal SSH target for a sandbox.
// The gateway token keeps this route private to trusted gateway callers.
export const resolveSandboxSshTarget = async (input: {
  readonly apiBaseUrl: string;
  readonly gatewayToken: string;
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
    },
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // Prefer API-provided human-readable error messages to simplify operator debugging.
    const parsedError = messageResponseSchema.safeParse(payload);
    throw new Error(
      parsedError.success
        ? parsedError.data.message
        : `SSH target resolution failed with status ${response.status}.`,
    );
  }

  return sandboxSshTargetSchema.parse(payload);
};
