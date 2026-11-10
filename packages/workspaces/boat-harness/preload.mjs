// Loaded into Core's worker and API with `node --import`. It sends every TLS connection for
// `boat.dev` and `*.on.boat.dev` to the harness's fake Boat on 127.0.0.1, keeping the real HTTPS
// origin, SNI and certificate checks (the harness CA arrives through NODE_EXTRA_CA_CERTS). This
// covers undici (the provider API, signed uploads and the receiver) and `ws` (the sealantd control
// WebSocket) alike. No production code changes. It fails closed: without a port it refuses to load,
// so a harness process can never reach the real Boat.
import tls from "node:tls";
import util from "node:util";

const port = Number(process.env.SEALANT_BOAT_HARNESS_PORT);
if (!Number.isInteger(port) || port <= 0)
  throw new Error("boat-harness preload: SEALANT_BOAT_HARNESS_PORT is required");

// Core's logs print error causes through util.inspect. Keep the whole chain, so a failure's
// innermost code (e.g. a BoatTunnelStoreError's) reaches the harness logs.
util.inspect.defaultOptions.depth = 12;

const boat = (host) => typeof host === "string" && /(^|\.)boat\.dev\.?$/i.test(host);
const original = tls.connect;

tls.connect = function connect(...args) {
  if (args[0] !== null && typeof args[0] === "object") {
    const options = args[0];
    const host = options.servername ?? options.host;
    if (boat(host)) args[0] = { ...options, host: "127.0.0.1", port, servername: host };
  } else if (typeof args[0] === "number" || typeof args[0] === "string") {
    const host = typeof args[1] === "string" ? args[1] : args[1]?.servername;
    if (boat(host)) {
      const rest = args.slice(typeof args[1] === "string" ? 2 : 1);
      const options = rest[0] !== null && typeof rest[0] === "object" ? rest.shift() : {};
      return original.call(
        this,
        { ...options, host: "127.0.0.1", port, servername: host },
        ...rest,
      );
    }
  }
  return original.apply(this, args);
};
