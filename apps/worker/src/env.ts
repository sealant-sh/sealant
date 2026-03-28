import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { homedir } from "node:os";

import { databaseEnvSchema } from "@sealant/db";
import { runtimeAdapterIdSchema } from "@sealant/runtime-adapters-api";
import { rabbitMqEnvSchema } from "@sealant/workspace-build-queue";
import { z } from "zod";

const sshEndpointExposureStrategySchema = z.enum(["host-published", "container-network"]);

const defaultWorkerId = `worker-${hostname()}-${process.pid}`;

const booleanFromEnvSchema = z.union([
  z.boolean(),
  z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1"),
]);

export const workerEnvSchema = databaseEnvSchema
  .merge(rabbitMqEnvSchema)
  .extend({
    REGISTRY_BASE_URL: z.string().url().default("http://127.0.0.1:5000"),
    REGISTRY_PUSH_REGISTRY: z.string().trim().min(1).default("127.0.0.1:5000"),
    REGISTRY_USERNAME: z.string().trim().min(1).optional(),
    REGISTRY_PASSWORD: z.string().min(1).optional(),
    GITHUB_API_BASE_URL: z.string().url().default("https://api.github.com"),
    GITHUB_APP_ID: z.string().trim().min(1).optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    GITHUB_APP_PRIVATE_KEY_PATH: z.string().trim().min(1).optional(),
    DOCKER_SOCKET_PATH: z.string().trim().min(1).default("/var/run/docker.sock"),
    DEFAULT_RUNTIME_ADAPTER: runtimeAdapterIdSchema.default("docker"),
    DEFAULT_WORKSPACE_STARTUP_MODE: z.enum(["idle", "harness"]).default("idle"),
    DEFAULT_WORKSPACE_IDLE_COMMAND: z.string().trim().min(1).default("while :; do sleep 30; done"),
    DEFAULT_WORKSPACE_SSH_ENABLED: booleanFromEnvSchema.default(true),
    DEFAULT_WORKSPACE_SSH_LISTEN_PORT: z.coerce.number().int().min(1).max(65535).default(2222),
    DEFAULT_SSH_AUTHORIZED_KEYS_FILE: z
      .string()
      .trim()
      .min(1)
      .default("/app/.secrets/authorized_keys"),
    DEFAULT_SSH_BIND_HOST: z.string().trim().min(1).default("127.0.0.1"),
    DEFAULT_SSH_ENDPOINT_EXPOSURE_STRATEGY:
      sshEndpointExposureStrategySchema.default("host-published"),
    WORKER_ID: z.string().trim().min(1).default(defaultWorkerId),
    WORKSPACE_BUILD_JOB_LEASE_DURATION_MS: z.coerce.number().int().positive().default(900000),
  })
  .superRefine((input, ctx) => {
    const hasGitHubPrivateKey =
      input.GITHUB_APP_PRIVATE_KEY !== undefined || input.GITHUB_APP_PRIVATE_KEY_PATH !== undefined;

    if ((input.GITHUB_APP_ID === undefined) !== !hasGitHubPrivateKey) {
      if (input.GITHUB_APP_ID === undefined) {
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
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

const expandEnvironmentPath = (value: string): string => {
  const homeDirectory = process.env.HOME ?? homedir();

  return value.replace(/^~(?=\/|$)/, homeDirectory).replace(/^\$HOME(?=\/|$)/, homeDirectory);
};

const resolveGitHubAppPrivateKey = (input: WorkerEnv): WorkerEnv => {
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
  return resolveGitHubAppPrivateKey(workerEnvSchema.parse(input));
};

const runtimeProcess = globalThis as typeof globalThis & {
  process?: {
    env?: NodeJS.ProcessEnv;
  };
};

export const env = parseWorkerEnv(runtimeProcess.process?.env ?? {});
