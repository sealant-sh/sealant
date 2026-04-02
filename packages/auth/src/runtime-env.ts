import { parseAuthEnv } from "@sealant/validators/env";

export { authEnvSchema, parseAuthEnv, type AuthEnv } from "@sealant/validators/env";

export const authEnv = parseAuthEnv(process.env);
