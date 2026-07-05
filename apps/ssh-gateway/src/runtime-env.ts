import { parseSshGatewayEnv } from "@sealant/validators/env";

import { ensureSshGatewayHostKey } from "./host-key.js";

// Opt-in first-boot host key generation must run before the parser, which reads the key file
// eagerly and refuses to start without it.
ensureSshGatewayHostKey(process.env);

export const env = parseSshGatewayEnv(process.env);
