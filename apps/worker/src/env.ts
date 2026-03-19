import { hostname } from "node:os";

import { databaseEnvSchema } from "@sealant/db";
import { rabbitMqEnvSchema } from "@sealant/workspace-build-queue";
import { z } from "zod";

const defaultWorkerId = `worker-${hostname()}-${process.pid}`;

export const workerEnvSchema = databaseEnvSchema.merge(rabbitMqEnvSchema).extend({
  REGISTRY_BASE_URL: z.string().url().default("http://127.0.0.1:5000"),
  REGISTRY_PUSH_REGISTRY: z.string().trim().min(1).default("127.0.0.1:5000"),
  REGISTRY_USERNAME: z.string().trim().min(1).optional(),
  REGISTRY_PASSWORD: z.string().min(1).optional(),
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
