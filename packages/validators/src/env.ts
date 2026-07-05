import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";

import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const rabbitMqEnvSchema = z.object({
  RABBITMQ_URL: z.string().trim().min(1).default("amqp://sealant:sealant@127.0.0.1:5673"),
  SANDBOX_BUILD_QUEUE_PREFETCH: z.coerce.number().int().positive().default(1),
});

export type RabbitMqEnv = z.infer<typeof rabbitMqEnvSchema>;

export const parseRabbitMqEnv = (input: Record<string, string | undefined>): RabbitMqEnv => {
  return rabbitMqEnvSchema.parse(input);
};

export const databaseEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .default("postgresql://sealant:sealant@127.0.0.1:5433/sealant_control_plane"),
});

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

export const parseDatabaseEnv = (input: Record<string, string | undefined>): DatabaseEnv => {
  return databaseEnvSchema.parse(input);
};

export const runtimeEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export const httpServerEnvSchema = runtimeEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(4000),
});

export const corsEnvSchema = z.object({
  CORS_ALLOWED_ORIGINS: z
    .string()
    .trim()
    .min(1)
    .default("http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001"),
});

export const registryCredentialsEnvSchema = z.object({
  REGISTRY_USERNAME: z.string().trim().min(1).optional(),
  REGISTRY_PASSWORD: z.string().min(1).optional(),
});

export const registryConnectionEnvSchema = z.object({
  REGISTRY_BASE_URL: z.string().url().default("http://127.0.0.1:5000"),
  REGISTRY_PUSH_REGISTRY: z.string().trim().min(1).default("127.0.0.1:5000"),
});

export const registryEnvSchema = registryConnectionEnvSchema
  .merge(registryCredentialsEnvSchema)
  .extend({
    REGISTRY_NAME: z.string().trim().min(1).default("default"),
  });

export const repologyEnvSchema = z.object({
  REPOLOGY_API_BASE_URL: z.string().url().default("https://repology.org/api/v1"),
  REPOLOGY_USER_AGENT: z
    .string()
    .trim()
    .min(1)
    .default("sealant-control-plane/0.1 (+https://github.com/sealant-ops/sealant)"),
  REPOLOGY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  REPOLOGY_MINIMUM_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
});

export const githubApiEnvSchema = z.object({
  GITHUB_API_BASE_URL: z.string().url().default("https://api.github.com"),
});

export const githubAppEnvSchema = z.object({
  GITHUB_APP_ID: z.string().trim().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().trim().min(1).optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
  GITHUB_APP_SLUG: z.string().trim().min(1).optional(),
});

export const githubOAuthEnvSchema = z.object({
  GITHUB_APP_CLIENT_ID: z.string().trim().min(1).optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
});

export const githubEnvSchema = githubApiEnvSchema
  .merge(githubAppEnvSchema)
  .merge(githubOAuthEnvSchema);

export const sandboxSshGatewayEnvSchema = z.object({
  SANDBOX_SSH_GATEWAY_TOKEN: z.string().trim().min(1).optional(),
  SANDBOX_SSH_GATEWAY_HOST: z.string().trim().min(1).optional(),
  SANDBOX_SSH_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SANDBOX_SSH_GATEWAY_USERNAME_PREFIX: z.string().trim().min(1).optional(),
});

const addRegistryCredentialsIssue = (
  registryUsername: string | undefined,
  registryPassword: string | undefined,
  ctx: z.RefinementCtx,
) => {
  if ((registryUsername === undefined) !== (registryPassword === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REGISTRY_PASSWORD"],
      message: "REGISTRY_USERNAME and REGISTRY_PASSWORD must be provided together.",
    });
  }
};

const addGitHubAppCredentialsIssue = (
  appId: string | undefined,
  privateKey: string | undefined,
  privateKeyPath: string | undefined,
  ctx: z.RefinementCtx,
) => {
  const hasGitHubPrivateKey = privateKey !== undefined || privateKeyPath !== undefined;

  if ((appId === undefined) !== !hasGitHubPrivateKey) {
    if (appId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GITHUB_APP_ID"],
        message:
          "GITHUB_APP_ID must be provided when GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH is set.",
      });
    }

    if (!hasGitHubPrivateKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GITHUB_APP_PRIVATE_KEY"],
        message:
          "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH must be provided when GITHUB_APP_ID is set.",
      });
    }
  }
};

export const expandEnvironmentPath = (value: string): string => {
  const homeDirectory = process.env.HOME ?? homedir();

  return value.replace(/^~(?=\/|$)/, homeDirectory).replace(/^\$HOME(?=\/|$)/, homeDirectory);
};

export const appCoreEnvSchema = httpServerEnvSchema
  .merge(corsEnvSchema)
  .merge(registryEnvSchema)
  .merge(repologyEnvSchema)
  .merge(githubEnvSchema)
  .merge(sandboxSshGatewayEnvSchema);

export const appServerEnvSchema = databaseEnvSchema
  .merge(rabbitMqEnvSchema)
  .merge(appCoreEnvSchema);

export const appEnvSchema = appServerEnvSchema.superRefine((input, ctx) => {
  addRegistryCredentialsIssue(input.REGISTRY_USERNAME, input.REGISTRY_PASSWORD, ctx);
  addGitHubAppCredentialsIssue(
    input.GITHUB_APP_ID,
    input.GITHUB_APP_PRIVATE_KEY,
    input.GITHUB_APP_PRIVATE_KEY_PATH,
    ctx,
  );

  if (
    (input.GITHUB_APP_CLIENT_ID === undefined) !==
    (input.GITHUB_APP_CLIENT_SECRET === undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["GITHUB_APP_CLIENT_SECRET"],
      message: "GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be provided together.",
    });
  }
});

export type AppEnv = z.infer<typeof appEnvSchema>;

const resolveAppGitHubPrivateKey = (input: AppEnv): AppEnv => {
  if (input.GITHUB_APP_PRIVATE_KEY_PATH === undefined) {
    return input;
  }

  const privateKeyPath = expandEnvironmentPath(input.GITHUB_APP_PRIVATE_KEY_PATH);
  const privateKey = readFileSync(privateKeyPath, "utf8");

  return {
    ...input,
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
  };
};

export const parseAppEnv = (input: NodeJS.ProcessEnv): AppEnv => {
  const runtimeEnv = createEnv({
    server: appServerEnvSchema.shape,
    runtimeEnv: input,
    emptyStringAsUndefined: true,
  });

  return resolveAppGitHubPrivateKey(appEnvSchema.parse(runtimeEnv));
};

const runtimeAdapterIdEnvSchema = z.enum(["docker", "k8s", "k3s"]);
const sshEndpointExposureStrategySchema = z.enum(["host-published", "container-network"]);
const defaultWorkerId = `worker-${hostname()}-${process.pid}`;

export const workerRuntimeEnvSchema = z.object({
  DOCKER_SOCKET_PATH: z.string().trim().min(1).default("/var/run/docker.sock"),
  // When set, the docker adapter bind-mounts each sandbox's /run/sealant control socket dir to
  // <dir>/<container> on the host, so the gateway can reach the daemon socket directly (unix://) with
  // NO Docker access. Leave unset to keep the universal docker-exec reach. Must be a host path shared
  // (same path) into both the worker (rw) and the ssh-gateway (ro).
  SANDBOX_CONTROL_SOCKET_HOST_DIR: z.string().trim().min(1).optional(),
  DEFAULT_RUNTIME_ADAPTER: runtimeAdapterIdEnvSchema.default("docker"),
  DEFAULT_SSH_AUTHORIZED_KEYS_FILE: z
    .string()
    .trim()
    .min(1)
    .default("/app/.secrets/authorized_keys"),
  DEFAULT_SSH_BIND_HOST: z.string().trim().min(1).default("127.0.0.1"),
  DEFAULT_SSH_ENDPOINT_EXPOSURE_STRATEGY:
    sshEndpointExposureStrategySchema.default("host-published"),
  WORKER_ID: z.string().trim().min(1).default(defaultWorkerId),
  SANDBOX_BUILD_JOB_LEASE_DURATION_MS: z.coerce.number().int().positive().default(900000),
  // How often the worker re-drives sandbox build jobs stranded by a dead lease holder (#5 reaper).
  SANDBOX_BUILD_JOB_REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
});

export const workerServerEnvSchema = databaseEnvSchema
  .merge(rabbitMqEnvSchema)
  .merge(registryConnectionEnvSchema)
  .merge(registryCredentialsEnvSchema)
  .merge(githubApiEnvSchema)
  .merge(githubAppEnvSchema)
  .merge(workerRuntimeEnvSchema);

export const workerEnvSchema = workerServerEnvSchema.superRefine((input, ctx) => {
  addRegistryCredentialsIssue(input.REGISTRY_USERNAME, input.REGISTRY_PASSWORD, ctx);
  addGitHubAppCredentialsIssue(
    input.GITHUB_APP_ID,
    input.GITHUB_APP_PRIVATE_KEY,
    input.GITHUB_APP_PRIVATE_KEY_PATH,
    ctx,
  );
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

const resolveWorkerGitHubPrivateKey = (input: WorkerEnv): WorkerEnv => {
  if (input.GITHUB_APP_PRIVATE_KEY_PATH === undefined) {
    return input;
  }

  const privateKeyPath = expandEnvironmentPath(input.GITHUB_APP_PRIVATE_KEY_PATH);
  const privateKey = readFileSync(privateKeyPath, "utf8");

  return {
    ...input,
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
  };
};

export const parseWorkerEnv = (input: NodeJS.ProcessEnv): WorkerEnv => {
  const runtimeEnv = createEnv({
    server: workerServerEnvSchema.shape,
    runtimeEnv: input,
    emptyStringAsUndefined: true,
  });

  return resolveWorkerGitHubPrivateKey(workerEnvSchema.parse(runtimeEnv));
};

export const sshGatewayCoreEnvSchema = z.object({
  // Loopback by default: the gateway runs with host networking in compose, so binding wider than
  // 127.0.0.1 exposes it publicly — that must be an explicit opt-in, not a default.
  SSH_GATEWAY_HOST: z.string().trim().min(1).default("127.0.0.1"),
  SSH_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(2222),
  SSH_GATEWAY_BANNER: z
    .string()
    .default(
      "Welcome to Sealant Sandbox Gateway. This session is routed through Sealant infrastructure.",
    ),
  SSH_GATEWAY_HOST_KEY_PATH: z.string().trim().min(1).default("./.secrets/ssh_gateway_host_key"),
  // Opt-in first-boot provisioning (packaged self-host): generate an ed25519 host key at
  // SSH_GATEWAY_HOST_KEY_PATH when the file is missing instead of refusing to start. An existing
  // key is never overwritten, so the gateway's host identity is stable once created.
  SSH_GATEWAY_HOST_KEY_AUTOGENERATE: z.stringbool().default(false),
  SSH_GATEWAY_ALLOWED_KEYS_FILE: z.string().trim().min(1).default("./.secrets/authorized_keys"),
  SSH_GATEWAY_SANDBOX_USERNAME_PREFIX: z.string().trim().min(1).default("sbx"),
  CORE_API_BASE_URL: z.string().url().default("http://127.0.0.1:4000"),
});

export const sshGatewayServerEnvSchema = runtimeEnvSchema
  .pick({
    NODE_ENV: true,
  })
  .merge(
    sandboxSshGatewayEnvSchema
      .pick({
        SANDBOX_SSH_GATEWAY_TOKEN: true,
      })
      .extend({
        SANDBOX_SSH_GATEWAY_TOKEN: z.string().trim().min(1),
      }),
  )
  .merge(sshGatewayCoreEnvSchema);

export const sshGatewayEnvSchema = sshGatewayServerEnvSchema;

export type SshGatewayEnv = z.infer<typeof sshGatewayEnvSchema>;
export type HydratedSshGatewayEnv = SshGatewayEnv & {
  readonly SSH_GATEWAY_HOST_KEY: string;
  readonly SSH_GATEWAY_ALLOWED_KEYS: string;
};

const readOptionalKeyFile = (filePath: string): string => {
  // The static allowlist is optional now that the gateway can resolve keys from the API: a missing
  // file means "no file-based keys", not a broken deployment. Other read errors still throw.
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
};

const hydrateSshGatewayFileContents = (input: SshGatewayEnv): HydratedSshGatewayEnv => {
  const hostKeyPath = expandEnvironmentPath(input.SSH_GATEWAY_HOST_KEY_PATH);
  const allowedKeysPath = expandEnvironmentPath(input.SSH_GATEWAY_ALLOWED_KEYS_FILE);

  return {
    ...input,
    SSH_GATEWAY_HOST_KEY_PATH: hostKeyPath,
    SSH_GATEWAY_ALLOWED_KEYS_FILE: allowedKeysPath,
    // The host key stays strictly required — the server cannot start without it.
    SSH_GATEWAY_HOST_KEY: readFileSync(hostKeyPath, "utf8"),
    SSH_GATEWAY_ALLOWED_KEYS: readOptionalKeyFile(allowedKeysPath),
  };
};

export const parseSshGatewayEnv = (input: NodeJS.ProcessEnv): HydratedSshGatewayEnv => {
  // createEnv already validates against the full schema shape (there are no cross-field
  // refinements here) — re-parsing its output would double-apply transforms like z.stringbool().
  const runtimeEnv = createEnv({
    server: sshGatewayServerEnvSchema.shape,
    runtimeEnv: input,
    emptyStringAsUndefined: true,
  });

  return hydrateSshGatewayFileContents(runtimeEnv);
};

const parseCsv = (value: string): Array<string> => {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

export const authEnvSchema = runtimeEnvSchema.merge(
  z.object({
    BETTER_AUTH_APP_NAME: z.string().trim().min(1).default("Sealant"),
    BETTER_AUTH_SECRET: z.string().trim().min(32).optional(),
    BETTER_AUTH_URL: z.string().url().optional(),
    BETTER_AUTH_TRUSTED_ORIGINS: z
      .string()
      .default("")
      .transform((value) => parseCsv(value)),
  }),
);

export type AuthEnv = z.infer<typeof authEnvSchema>;

export const parseAuthEnv = (input: Record<string, string | undefined>): AuthEnv => {
  const env = authEnvSchema.parse(input);

  if (env.BETTER_AUTH_URL !== undefined) {
    return env;
  }

  if (env.NODE_ENV === "production") {
    return env;
  }

  return {
    ...env,
    BETTER_AUTH_URL:
      input.PORT === undefined ? "http://localhost:3000" : `http://localhost:${input.PORT}`,
  };
};
