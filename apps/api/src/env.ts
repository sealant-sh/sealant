import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { databaseEnvSchema } from "@sealant/db";
import { rabbitMqEnvSchema } from "@sealant/rabbitmq";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const appServerEnvShape = {
  ...databaseEnvSchema.shape,
  ...rabbitMqEnvSchema.shape,
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
  GITHUB_API_BASE_URL: z.string().url().default("https://api.github.com"),
  GITHUB_APP_ID: z.string().trim().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().trim().min(1).optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_ID: z.string().trim().min(1).optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_APP_SLUG: z.string().trim().min(1).optional(),
  SANDBOX_SSH_GATEWAY_TOKEN: z.string().trim().min(1).optional(),
  SANDBOX_SSH_GATEWAY_HOST: z.string().trim().min(1).optional(),
  SANDBOX_SSH_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SANDBOX_SSH_GATEWAY_USERNAME_PREFIX: z.string().trim().min(1).optional(),
};

export const appEnvSchema = z.object(appServerEnvShape).superRefine((input, ctx) => {
  if ((input.REGISTRY_USERNAME === undefined) !== (input.REGISTRY_PASSWORD === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REGISTRY_PASSWORD"],
      message: "REGISTRY_USERNAME and REGISTRY_PASSWORD must be provided together.",
    });
  }

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

const expandEnvironmentPath = (value: string): string => {
  const homeDirectory = process.env.HOME ?? homedir();

  return value.replace(/^~(?=\/|$)/, homeDirectory).replace(/^\$HOME(?=\/|$)/, homeDirectory);
};

const resolveGitHubAppPrivateKey = (input: AppEnv): AppEnv => {
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
    server: appServerEnvShape,
    runtimeEnv: input,
    emptyStringAsUndefined: true,
  });

  return resolveGitHubAppPrivateKey(appEnvSchema.parse(runtimeEnv));
};

const runtimeProcess = globalThis as typeof globalThis & {
  process?: {
    env?: NodeJS.ProcessEnv;
  };
};

export const env = parseAppEnv(runtimeProcess.process?.env ?? {});
