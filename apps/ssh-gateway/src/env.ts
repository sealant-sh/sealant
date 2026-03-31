import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const booleanFromEnvSchema = z.union([
  z.boolean(),
  z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1"),
]);

// Environment contract for the gateway process.
// We keep string parsing strict here so runtime failures happen at startup,
// not halfway through handling a user SSH session.
const sshGatewayServerEnvShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SSH_GATEWAY_HOST: z.string().trim().min(1).default("0.0.0.0"),
  SSH_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(2222),
  SSH_GATEWAY_BANNER: z
    .string()
    .default(
      "Welcome to Sealant Sandbox Gateway. This session is routed through Sealant infrastructure.",
    ),
  SSH_GATEWAY_HOST_KEY_PATH: z.string().trim().min(1).default("./.secrets/ssh_gateway_host_key"),
  SSH_GATEWAY_ALLOWED_KEYS_FILE: z.string().trim().min(1).default("./.secrets/authorized_keys"),
  SSH_GATEWAY_SANDBOX_USERNAME_PREFIX: z.string().trim().min(1).default("sbx"),
  // Base URL for control-plane API used to resolve runtime endpoint per sandbox.
  CORE_API_BASE_URL: z.string().url().default("http://127.0.0.1:4000"),
  // Shared secret for calling the internal ssh-target route.
  SANDBOX_SSH_GATEWAY_TOKEN: z.string().trim().min(1),
  // Private key used by gateway to authenticate *to* sandbox runtime SSH.
  SSH_UPSTREAM_PRIVATE_KEY_PATH: z.string().trim().min(1).default("./.secrets/id_ed25519"),
  SSH_UPSTREAM_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // false in dev for convenience; true in hardened environments.
  SSH_UPSTREAM_STRICT_HOST_KEY_CHECKING: booleanFromEnvSchema.default(false),
};

export const sshGatewayEnvSchema = z.object(sshGatewayServerEnvShape);

export type SshGatewayEnv = z.infer<typeof sshGatewayEnvSchema>;

const expandEnvironmentPath = (value: string): string => {
  const homeDirectory = process.env.HOME ?? homedir();

  return value.replace(/^~(?=\/|$)/, homeDirectory).replace(/^\$HOME(?=\/|$)/, homeDirectory);
};

// Parse env first, then hydrate file-backed values (keys) into memory.
// This makes the rest of the app independent from filesystem lookups.
const hydrateFileContents = (
  input: SshGatewayEnv,
): SshGatewayEnv & {
  readonly SSH_GATEWAY_HOST_KEY: string;
  readonly SSH_GATEWAY_ALLOWED_KEYS: string;
  readonly SSH_UPSTREAM_PRIVATE_KEY: string;
} => {
  const hostKeyPath = expandEnvironmentPath(input.SSH_GATEWAY_HOST_KEY_PATH);
  const allowedKeysPath = expandEnvironmentPath(input.SSH_GATEWAY_ALLOWED_KEYS_FILE);
  const upstreamPrivateKeyPath = expandEnvironmentPath(input.SSH_UPSTREAM_PRIVATE_KEY_PATH);

  return {
    ...input,
    SSH_GATEWAY_HOST_KEY_PATH: hostKeyPath,
    SSH_GATEWAY_ALLOWED_KEYS_FILE: allowedKeysPath,
    SSH_UPSTREAM_PRIVATE_KEY_PATH: upstreamPrivateKeyPath,
    SSH_GATEWAY_HOST_KEY: readFileSync(hostKeyPath, "utf8"),
    SSH_GATEWAY_ALLOWED_KEYS: readFileSync(allowedKeysPath, "utf8"),
    SSH_UPSTREAM_PRIVATE_KEY: readFileSync(upstreamPrivateKeyPath, "utf8"),
  };
};

export const parseSshGatewayEnv = (input: NodeJS.ProcessEnv) => {
  const runtimeEnv = createEnv({
    server: sshGatewayServerEnvShape,
    runtimeEnv: input,
    emptyStringAsUndefined: true,
  });

  // One parse call gives us validated scalars plus in-memory key material.
  return hydrateFileContents(sshGatewayEnvSchema.parse(runtimeEnv));
};

const runtimeProcess = globalThis as typeof globalThis & {
  process?: {
    env?: NodeJS.ProcessEnv;
  };
};

export const env = parseSshGatewayEnv(runtimeProcess.process?.env ?? {});
