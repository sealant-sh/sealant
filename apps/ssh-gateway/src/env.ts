import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { z } from "zod";

const booleanFromEnvSchema = z.union([
  z.boolean(),
  z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1"),
]);

export const sshGatewayEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SSH_GATEWAY_HOST: z.string().trim().min(1).default("0.0.0.0"),
  SSH_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(2222),
  SSH_GATEWAY_HOST_KEY_PATH: z.string().trim().min(1).default("./.secrets/ssh_gateway_host_key"),
  SSH_GATEWAY_ALLOWED_KEYS_FILE: z.string().trim().min(1).default("./.secrets/authorized_keys"),
  SSH_GATEWAY_SANDBOX_USERNAME_PREFIX: z.string().trim().min(1).default("sbx"),
  CORE_API_BASE_URL: z.string().url().default("http://127.0.0.1:4000"),
  SANDBOX_SSH_GATEWAY_TOKEN: z.string().trim().min(1),
  SSH_UPSTREAM_PRIVATE_KEY_PATH: z.string().trim().min(1).default("./.secrets/id_ed25519"),
  SSH_UPSTREAM_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  SSH_UPSTREAM_STRICT_HOST_KEY_CHECKING: booleanFromEnvSchema.default(false),
});

export type SshGatewayEnv = z.infer<typeof sshGatewayEnvSchema>;

const expandEnvironmentPath = (value: string): string => {
  const homeDirectory = process.env.HOME ?? homedir();

  return value.replace(/^~(?=\/|$)/, homeDirectory).replace(/^\$HOME(?=\/|$)/, homeDirectory);
};

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
  return hydrateFileContents(sshGatewayEnvSchema.parse(input));
};

const runtimeProcess = globalThis as typeof globalThis & {
  process?: {
    env?: NodeJS.ProcessEnv;
  };
};

export const env = parseSshGatewayEnv(runtimeProcess.process?.env ?? {});
