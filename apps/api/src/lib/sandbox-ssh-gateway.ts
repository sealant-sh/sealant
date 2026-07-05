import type { SandboxSshGatewayConfig } from "@sealant/sandboxes";

import { env } from "../runtime-env.js";

/** Gateway connect coordinates from env; undefined when SANDBOX_SSH_GATEWAY_HOST is unset. */
export const resolveSandboxSshGatewayConfig = (): SandboxSshGatewayConfig | undefined => {
  const host = env.SANDBOX_SSH_GATEWAY_HOST?.trim();

  if (host === undefined || host.length === 0) {
    return undefined;
  }

  return {
    host,
    ...(env.SANDBOX_SSH_GATEWAY_PORT === undefined ? {} : { port: env.SANDBOX_SSH_GATEWAY_PORT }),
    ...(env.SANDBOX_SSH_GATEWAY_USERNAME_PREFIX === undefined
      ? {}
      : { usernamePrefix: env.SANDBOX_SSH_GATEWAY_USERNAME_PREFIX }),
  };
};
