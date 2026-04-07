import { serve } from "@hono/node-server";

import { createDefaultApiApp } from "./app.js";
import { env } from "./runtime-env.js";

const app = await createDefaultApiApp();
const databaseUrl = new URL(env.DATABASE_URL);

console.log(`Sealant API listening on http://localhost:${env.PORT}`);
console.log(`[api] database: ${databaseUrl.protocol}//${databaseUrl.host}${databaseUrl.pathname}`);
console.log(`[api] repology endpoint: ${env.REPOLOGY_API_BASE_URL}`);

serve({
  fetch: app.fetch,
  port: env.PORT,
});
