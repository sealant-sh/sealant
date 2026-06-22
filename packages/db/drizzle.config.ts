import { parseDatabaseEnv } from "@sealant/validators/env";
import { defineConfig } from "drizzle-kit";

const env = parseDatabaseEnv(process.env);

export default defineConfig({
  schema: [
    "./src/schema/auth.ts",
    "./src/schema/control-plane.ts",
    "./src/schema/sandbox-build-jobs.ts",
    "./src/schema/telemetry.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
