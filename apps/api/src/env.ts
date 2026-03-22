import { databaseEnvSchema } from "@sealant/db";
import { rabbitMqEnvSchema } from "@sealant/workspace-build-queue";
import { z } from "zod";

export const appEnvSchema = databaseEnvSchema
  .merge(rabbitMqEnvSchema)
  .merge(
    z.object({
      NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
      PORT: z.coerce.number().int().positive().default(4000),
      CORS_ALLOWED_ORIGINS: z
        .string()
        .trim()
        .min(1)
        .default("http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001"),
      REGISTRY_NAME: z.string().trim().min(1).default("default"),
      REGISTRY_BASE_URL: z.string().url().default("http://127.0.0.1:5000"),
      REGISTRY_PUSH_REGISTRY: z.string().trim().min(1).default("127.0.0.1:5000"),
      REGISTRY_USERNAME: z.string().trim().min(1).optional(),
      REGISTRY_PASSWORD: z.string().min(1).optional(),
      REPOLOGY_API_BASE_URL: z.string().url().default("https://repology.org/api/v1"),
      REPOLOGY_USER_AGENT: z
        .string()
        .trim()
        .min(1)
        .default("sealant-control-plane/0.1 (+https://github.com/sealant-ops/sealant)"),
      REPOLOGY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
      REPOLOGY_MINIMUM_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
    }),
  )
  .superRefine((input, ctx) => {
    if ((input.REGISTRY_USERNAME === undefined) !== (input.REGISTRY_PASSWORD === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REGISTRY_PASSWORD"],
        message: "REGISTRY_USERNAME and REGISTRY_PASSWORD must be provided together.",
      });
    }
  });

export type AppEnv = z.infer<typeof appEnvSchema>;

export const parseAppEnv = (input: NodeJS.ProcessEnv): AppEnv => {
  return appEnvSchema.parse(input);
};

const runtimeProcess = globalThis as typeof globalThis & {
  process?: {
    env?: NodeJS.ProcessEnv;
  };
};

export const env = parseAppEnv(runtimeProcess.process?.env ?? {});
