import process from "node:process";

import { defineConfig } from "drizzle-kit";

import { parseDatabaseEnv } from "./src/env.js";

const env = parseDatabaseEnv(process.env);

export default defineConfig({
  schema: ["./src/schema/*.ts"],
  out: "./drizzle",
  dialect: "sqlite",
  casing: "snake_case",
  dbCredentials: {
    url: env.DATABASE_FILE_PATH,
  },
});
