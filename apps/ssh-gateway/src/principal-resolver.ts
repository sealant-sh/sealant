import { z } from "zod";

/*
Key -> principal resolution against the API (POST /v1/ssh-keys/resolve-principal). This is how a
user-registered key (ssh_keys table) authenticates at the gateway without any static allowlist
entry or gateway restart. Same trust wiring as sandbox-target.ts: the gateway token authenticates
the gateway; the API recomputes the fingerprint from the offered key blob server-side.
*/

// Exact response contract from the API. Keeping this local schema means the gateway fails loudly
// if the API shape drifts.
const resolveSshPrincipalResponseSchema = z.object({
  principalId: z.string().trim().min(1),
  sshKeyId: z.string().trim().min(1),
  fingerprint: z.string().trim().min(1),
});

/**
 * Tri-state on purpose: a definitive 404 means "this key is unknown — reject the key"; a network
 * error / 5xx / timeout means "the lookup itself failed — reject this auth attempt". The two must
 * never collapse into each other, or an API outage silently changes auth semantics.
 */
export type PrincipalLookupResult =
  | { readonly kind: "found"; readonly principalId: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly message: string };

export type PrincipalLookup = (key: {
  readonly algo: string;
  readonly data: Uint8Array;
}) => Promise<PrincipalLookupResult>;

export const createPrincipalResolver = (input: {
  readonly apiBaseUrl: string;
  readonly gatewayToken: string;
  readonly timeoutMs?: number;
}): PrincipalLookup => {
  const timeoutMs = input.timeoutMs ?? 5_000;

  return async (key) => {
    try {
      const response = await fetch(new URL("/v1/ssh-keys/resolve-principal", input.apiBaseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Shared secret between gateway and API for this internal endpoint.
          "x-sealant-gateway-token": input.gatewayToken,
        },
        body: JSON.stringify({
          algo: key.algo,
          publicKeyBase64: Buffer.from(key.data).toString("base64"),
        }),
        // Bound the auth-time RTT so a hung API cannot pin SSH handshakes indefinitely.
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status === 404) {
        return { kind: "not-found" };
      }

      if (!response.ok) {
        return {
          kind: "error",
          message: `Principal resolution failed with status ${response.status}.`,
        };
      }

      const payload = resolveSshPrincipalResponseSchema.parse(await response.json());
      return { kind: "found", principalId: payload.principalId };
    } catch (error) {
      return {
        kind: "error",
        message: error instanceof Error ? error.message : "Principal resolution failed.",
      };
    }
  };
};
