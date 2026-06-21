import { parseAuthorizedKeys } from "./authorized-keys.js";
import { startSshGatewayServer } from "./gateway-server.js";
import { env } from "./runtime-env.js";

// Entry point responsibilities:
// 1) Load/validate configuration and key material.
// 2) Start SSH gateway listener.
// 3) Handle process shutdown cleanly.

// Load the gateway client allowlist once at startup. We do not hot-reload keys in this
// implementation so runtime behavior is deterministic per process start.
const allowedClientKeys = parseAuthorizedKeys(env.SSH_GATEWAY_ALLOWED_KEYS);

if (allowedClientKeys.length === 0) {
  throw new Error("No SSH client keys were loaded from SSH_GATEWAY_ALLOWED_KEYS_FILE.");
}

console.log("[ssh-gateway] starting", {
  host: env.SSH_GATEWAY_HOST,
  port: env.SSH_GATEWAY_PORT,
  coreApiBaseUrl: env.CORE_API_BASE_URL,
  usernamePrefix: env.SSH_GATEWAY_SANDBOX_USERNAME_PREFIX,
  allowedClientKeys: allowedClientKeys.length,
});

const main = async () => {
  // Start the SSH server with fully-resolved config values from env.ts.
  const runtime = await startSshGatewayServer({
    host: env.SSH_GATEWAY_HOST,
    port: env.SSH_GATEWAY_PORT,
    hostKey: env.SSH_GATEWAY_HOST_KEY,
    banner: env.SSH_GATEWAY_BANNER,
    allowedClientKeys,
    sandboxUsernamePrefix: env.SSH_GATEWAY_SANDBOX_USERNAME_PREFIX,
    coreApiBaseUrl: env.CORE_API_BASE_URL,
    gatewayToken: env.SANDBOX_SSH_GATEWAY_TOKEN,
  });

  const shutdown = async () => {
    // Graceful stop lets existing channels close cleanly.
    await runtime.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    // Ctrl+C in dev.
    void shutdown();
  });

  process.on("SIGTERM", () => {
    // Container stop in docker/k8s.
    void shutdown();
  });
};

void main();
