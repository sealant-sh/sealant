import type { WebSocketConnectMaterial } from "../../sealantd/runtime.js";
import { BOAT_AGENT_TUNNEL_ROUTE } from "./agent-contract.js";
import { BoatApiError, BoatSecret, parseBoatUrl, type BoatResult } from "./config.js";

export interface BoatHostedControl {
  readonly origin: string;
  readonly cookie: BoatSecret;
}

/**
 * The query parameters Boat puts on a hosted port's URL: the access token, and since 25 Nov 2026 the
 * port's `_generation`. sealant reads only the token (sent as the `_port_auth` cookie); a parameter
 * Boat has not been seen to send still refuses the URL.
 */
const HOSTED_PARAMS = new Set(["_token", "_generation"]);

export const parseBoatHostedControl = (input: string): BoatResult<BoatHostedControl> => {
  const parsed = parseBoatUrl(input);
  if (!parsed.ok) return parsed;
  const url = parsed.value;
  const names = [...url.searchParams.keys()];
  const token = BoatSecret.parse(url.searchParams.get("_token"));
  if (
    !token.ok ||
    url.pathname !== "/" ||
    !names.every((name) => HOSTED_PARAMS.has(name)) ||
    new Set(names).size !== names.length ||
    !url.searchParams.has("_token")
  ) {
    return { ok: false, error: new BoatApiError("host", null, "invalid_hosted_control") };
  }
  return { ok: true, value: { origin: url.origin, cookie: token.value } };
};

/** The headers that authenticate sealant to the agent through Boat's hosted proxy. */
const hostedHeaders = (access: BoatHostedControl, relayToken: BoatSecret) => ({
  Cookie: `_port_auth=${access.cookie.reveal()}`,
  Authorization: `Bearer ${relayToken.reveal()}`,
});

/** sealant's end of the resource tunnel's WebSocket carrier (`/sealant/tunnel`). */
export const boatTunnelConnection = (
  access: BoatHostedControl,
  relayToken: BoatSecret,
): { readonly url: string; readonly headers: Readonly<Record<string, string>> } => ({
  url: `${access.origin.replace(/^https:/, "wss:")}${BOAT_AGENT_TUNNEL_ROUTE}`,
  headers: hostedHeaders(access, relayToken),
});

export const boatControlConnection = (
  access: BoatHostedControl,
  relayToken: BoatSecret,
): { readonly url: string; readonly prepare: () => Promise<WebSocketConnectMaterial> } => ({
  url: `${access.origin.replace(/^https:/, "wss:")}/sealant/control`,
  prepare: async () => ({ headers: hostedHeaders(access, relayToken) }),
});
