import { hostname } from "node:os";

import { databaseEnvSchema } from "@sealant/db";
import { runtimeAdapterIdSchema } from "@sealant/runtime-adapters-api";
import { rabbitMqEnvSchema } from "@sealant/workspace-build-queue";
import { z } from "zod";

const defaultWorkerId = `worker-${hostname()}-${process.pid}`;

const booleanFromEnvSchema = z.union([
  z.boolean(),
  z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1"),
]);

export const workerEnvSchema = databaseEnvSchema.merge(rabbitMqEnvSchema).extend({
  REGISTRY_BASE_URL: z.string().url().default("http://127.0.0.1:5000"),
  REGISTRY_PUSH_REGISTRY: z.string().trim().min(1).default("127.0.0.1:5000"),
  REGISTRY_USERNAME: z.string().trim().min(1).optional(),
  REGISTRY_PASSWORD: z.string().min(1).optional(),
  DOCKER_SOCKET_PATH: z.string().trim().min(1).default("/var/run/docker.sock"),
  COMPOSE_PROJECT_NAME: z.string().trim().min(1).default("sealant"),
  NIX_BUILDER_SERVICE: z.string().trim().min(1).default("nix-builder"),
  DEFAULT_RUNTIME_ADAPTER: runtimeAdapterIdSchema.default("docker"),
  DEFAULT_WORKSPACE_STARTUP_MODE: z.enum(["idle", "harness"]).default("idle"),
  DEFAULT_WORKSPACE_IDLE_COMMAND: z
    .string()
    .trim()
    .min(1)
    .default("while :; do sleep 30; done"),
  DEFAULT_WORKSPACE_SSH_ENABLED: booleanFromEnvSchema.default(true),
  DEFAULT_WORKSPACE_SSH_LISTEN_PORT: z.coerce.number().int().min(1).max(65535).default(2222),
  DEFAULT_SSH_AUTHORIZED_KEYS_FILE: z
    .string()
    .trim()
    .min(1)
    .default("/workspace/.secrets/authorized_keys"),
  DEFAULT_SSH_BIND_HOST: z.string().trim().min(1).default("127.0.0.1"),
  WORKER_ID: z.string().trim().min(1).default(defaultWorkerId),
  WORKSPACE_BUILD_JOB_LEASE_DURATION_MS: z.coerce.number().int().positive().default(900000),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const parseWorkerEnv = (input: NodeJS.ProcessEnv): WorkerEnv => {
  return workerEnvSchema.parse(input);
};

const runtimeProcess = globalThis as typeof globalThis & {
  process?: {
    env?: NodeJS.ProcessEnv;
  };
};

export const env = parseWorkerEnv(runtimeProcess.process?.env ?? {});
