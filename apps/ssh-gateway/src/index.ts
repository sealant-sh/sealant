import { parseAuthorizedKeys } from "./authorized-keys.js";
import { env } from "./env.js";
import { startSshGatewayServer } from "./gateway-server.js";

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
  strictUpstreamHostKeyChecking: env.SSH_UPSTREAM_STRICT_HOST_KEY_CHECKING,
});

const main = async () => {
  const runtime = await startSshGatewayServer({
    host: env.SSH_GATEWAY_HOST,
    port: env.SSH_GATEWAY_PORT,
    hostKey: env.SSH_GATEWAY_HOST_KEY,
    allowedClientKeys,
    sandboxUsernamePrefix: env.SSH_GATEWAY_SANDBOX_USERNAME_PREFIX,
    coreApiBaseUrl: env.CORE_API_BASE_URL,
    gatewayToken: env.SANDBOX_SSH_GATEWAY_TOKEN,
    upstreamPrivateKey: env.SSH_UPSTREAM_PRIVATE_KEY,
    upstreamReadyTimeoutMs: env.SSH_UPSTREAM_READY_TIMEOUT_MS,
    strictUpstreamHostKeyChecking: env.SSH_UPSTREAM_STRICT_HOST_KEY_CHECKING,
  });

  const shutdown = async () => {
    await runtime.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
};

void main();
