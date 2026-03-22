import { serve } from "@hono/node-server";

import app from "./app.js";
import { env } from "./env.js";

console.log(`Sealant API listening on http://localhost:${env.PORT}`);
console.log(`[api] database file: ${env.DATABASE_FILE_PATH}`);
console.log(`[api] repology endpoint: ${env.REPOLOGY_API_BASE_URL}`);

serve({
  fetch: app.fetch,
  port: env.PORT,
});
