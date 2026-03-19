import { serve } from "@hono/node-server";

import app from "./app.js";
import { env } from "./env.js";

console.log(`Sealant API listening on http://localhost:${env.PORT}`);

serve({
  fetch: app.fetch,
  port: env.PORT,
});
