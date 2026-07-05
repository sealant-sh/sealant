import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { expandEnvironmentPath, sshGatewayCoreEnvSchema } from "@sealant/validators/env";
// Default import: ssh2 stays external to the esbuild bundle (native bindings), and as a CJS module
// its named exports are not statically resolvable from ESM at runtime.
import ssh2 from "ssh2";

// First-boot host key provisioning. Must run before parseSshGatewayEnv, which reads the key file
// eagerly and refuses to start without it — this is what lets the packaged compose boot on a fresh
// volume with no host-side tooling (no ssh-keygen). Generation is opt-in
// (SSH_GATEWAY_HOST_KEY_AUTOGENERATE) and only fires when the file is missing: an existing key is
// never overwritten, so the gateway's host identity is stable once created.

const bootstrapEnvSchema = sshGatewayCoreEnvSchema.pick({
  SSH_GATEWAY_HOST_KEY_PATH: true,
  SSH_GATEWAY_HOST_KEY_AUTOGENERATE: true,
});

export const ensureSshGatewayHostKey = (processEnv: NodeJS.ProcessEnv): void => {
  const env = bootstrapEnvSchema.parse({
    SSH_GATEWAY_HOST_KEY_PATH: processEnv.SSH_GATEWAY_HOST_KEY_PATH || undefined,
    SSH_GATEWAY_HOST_KEY_AUTOGENERATE: processEnv.SSH_GATEWAY_HOST_KEY_AUTOGENERATE || undefined,
  });

  if (!env.SSH_GATEWAY_HOST_KEY_AUTOGENERATE) {
    return;
  }

  const hostKeyPath = expandEnvironmentPath(env.SSH_GATEWAY_HOST_KEY_PATH);

  if (existsSync(hostKeyPath)) {
    return;
  }

  // ssh2's own generator guarantees a format its parser accepts (OpenSSH-format ed25519).
  const keyPair = ssh2.utils.generateKeyPairSync("ed25519");

  mkdirSync(dirname(hostKeyPath), { recursive: true, mode: 0o700 });
  writeFileSync(hostKeyPath, keyPair.private, { mode: 0o600 });
  writeFileSync(`${hostKeyPath}.pub`, `${keyPair.public.trim()}\n`, { mode: 0o644 });

  console.log(`[ssh-gateway] generated host key at ${hostKeyPath}`);
};
