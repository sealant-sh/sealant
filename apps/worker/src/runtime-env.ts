import { parseWorkerEnv } from "@sealant/validators/env";

export const env = parseWorkerEnv(process.env);
