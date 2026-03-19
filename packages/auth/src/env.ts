import { z } from "zod";

const parseCsv = (value: string): Array<string> => {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

export const authEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BETTER_AUTH_APP_NAME: z.string().trim().min(1).default("Sealant"),
  BETTER_AUTH_SECRET: z.string().trim().min(32).optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  BETTER_AUTH_TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((value) => parseCsv(value)),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

export const parseAuthEnv = (input: Record<string, string | undefined>): AuthEnv => {
  return authEnvSchema.parse(input);
};

const runtimeProcess = globalThis as typeof globalThis & {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

export const authEnv = parseAuthEnv(runtimeProcess.process?.env ?? {});
