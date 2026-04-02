import { parseSshGatewayEnv } from "@sealant/validators/env";

export const env = parseSshGatewayEnv(process.env);
