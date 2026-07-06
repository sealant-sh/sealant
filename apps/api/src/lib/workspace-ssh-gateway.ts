import type { WorkspaceSshGatewayConfig } from "@sealant/workspaces";

import { env } from "../runtime-env.js";

/** Gateway connect coordinates from env; undefined when WORKSPACE_SSH_GATEWAY_HOST is unset. */
export const resolveWorkspaceSshGatewayConfig = (): WorkspaceSshGatewayConfig | undefined => {
  const host = env.WORKSPACE_SSH_GATEWAY_HOST?.trim();

  if (host === undefined || host.length === 0) {
    return undefined;
  }

  return {
    host,
    ...(env.WORKSPACE_SSH_GATEWAY_PORT === undefined
      ? {}
      : { port: env.WORKSPACE_SSH_GATEWAY_PORT }),
    ...(env.WORKSPACE_SSH_GATEWAY_USERNAME_PREFIX === undefined
      ? {}
      : { usernamePrefix: env.WORKSPACE_SSH_GATEWAY_USERNAME_PREFIX }),
  };
};
