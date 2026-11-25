import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { expandEnvironmentPath, sshGatewayCoreEnvSchema } from "@sealant/validators/env";
// Default import: ssh2 stays external to the esbuild bundle (native bindings), and as a CJS module
// its named exports are not statically resolvable from ESM at runtime.
import ssh2 from "ssh2";

// First-boot host key provisioning. Must run before parseSshGatewayEnv, which reads the key file
// eagerly and refuses to start without it — this is what lets the packaged compose boot on a fresh
// volume with no host-side tooling (no ssh-keygen). Generation is opt-in
// (SSH_GATEWAY_HOST_KEY_AUTOGENERATE). It writes a key when the file is missing, or when the file
// holds a key ssh2 cannot parse: the gateway could never have started with that key, so it never
// served as a host identity, and replacing it is what repairs an install stuck in a crash loop. A
// key that parses is never overwritten, so the gateway's host identity is stable once created.

const bootstrapEnvSchema = sshGatewayCoreEnvSchema.pick({
  SSH_GATEWAY_HOST_KEY_PATH: true,
  SSH_GATEWAY_HOST_KEY_AUTOGENERATE: true,
});

const MAX_GENERATE_ATTEMPTS = 16;

/**
 * An ed25519 key pair in OpenSSH format that ssh2's parser accepts.
 *
 * ssh2 1.17.0's generator strips every leading zero byte from the public key, so about 1 key in
 * 256 comes out with a 31-byte public key that its own parser refuses ("Malformed OpenSSH private
 * key"). Generate again until the key parses.
 */
export const generateEd25519KeyPair = (): { readonly private: string; readonly public: string } => {
  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt += 1) {
    const keyPair = ssh2.utils.generateKeyPairSync("ed25519");
    if (!(ssh2.utils.parseKey(keyPair.private) instanceof Error)) {
      return keyPair;
    }
  }
  throw new Error(`ssh2 generated ${String(MAX_GENERATE_ATTEMPTS)} ed25519 keys it cannot parse`);
};

export const ensureSshGatewayHostKey = (processEnv: NodeJS.ProcessEnv): void => {
  const env = bootstrapEnvSchema.parse({
    SSH_GATEWAY_HOST_KEY_PATH: processEnv.SSH_GATEWAY_HOST_KEY_PATH || undefined,
    SSH_GATEWAY_HOST_KEY_AUTOGENERATE: processEnv.SSH_GATEWAY_HOST_KEY_AUTOGENERATE || undefined,
  });

  if (!env.SSH_GATEWAY_HOST_KEY_AUTOGENERATE) {
    return;
  }

  const hostKeyPath = expandEnvironmentPath(env.SSH_GATEWAY_HOST_KEY_PATH);
  const replacing = existsSync(hostKeyPath);

  if (replacing && !(ssh2.utils.parseKey(readFileSync(hostKeyPath)) instanceof Error)) {
    return;
  }

  const keyPair = generateEd25519KeyPair();

  mkdirSync(dirname(hostKeyPath), { recursive: true, mode: 0o700 });
  writeFileSync(hostKeyPath, keyPair.private, { mode: 0o600 });
  writeFileSync(`${hostKeyPath}.pub`, `${keyPair.public.trim()}\n`, { mode: 0o644 });

  console.log(
    replacing
      ? `[ssh-gateway] replaced host key at ${hostKeyPath}: the key there could not be parsed`
      : `[ssh-gateway] generated host key at ${hostKeyPath}`,
  );
};
