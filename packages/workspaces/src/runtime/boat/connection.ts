import type { WebSocketConnectMaterial } from "../../sealantd/runtime.js";
import { BOAT_AGENT_TUNNEL_ROUTE } from "./agent-contract.js";
import { BoatApiError, BoatSecret, parseBoatUrl, type BoatResult } from "./config.js";

export interface BoatHostedControl {
  readonly origin: string;
  readonly cookie: BoatSecret;
}

export const parseBoatHostedControl = (input: string): BoatResult<BoatHostedControl> => {
  const parsed = parseBoatUrl(input);
  if (!parsed.ok) return parsed;
  const url = parsed.value;
  const token = BoatSecret.parse(url.searchParams.get("_token"));
  if (
    !token.ok ||
    url.pathname !== "/" ||
    [...url.searchParams.keys()].length !== 1 ||
    !url.searchParams.has("_token")
  ) {
    return { ok: false, error: new BoatApiError("host", null, "invalid_hosted_control") };
  }
  return { ok: true, value: { origin: url.origin, cookie: token.value } };
};

/** The headers that authenticate Core to the agent through Boat's hosted proxy. */
const hostedHeaders = (access: BoatHostedControl, relayToken: BoatSecret) => ({
  Cookie: `_port_auth=${access.cookie.reveal()}`,
  Authorization: `Bearer ${relayToken.reveal()}`,
});

/** Core's end of the resource tunnel's WebSocket carrier (`/sealant/tunnel`). */
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
