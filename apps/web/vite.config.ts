import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// The release the browser reports to Sentry: fixed at build time, so it always names the bundle it
// ships in and matches the source maps uploaded with it (scripts/source-maps.mjs). It is
// `sealant-web@<version>`; Sentry drops a release containing `/`, so a scoped npm name is refused.
const sentryRelease = process.env.SENTRY_RELEASE?.trim() ?? "";
if (sentryRelease.includes("/")) {
  throw new Error(`SENTRY_RELEASE "${sentryRelease}" contains "/"; use sealant-web@<version>.`);
}

const config = defineConfig({
  define: {
    SEALANT_WEB_RELEASE: JSON.stringify(sentryRelease),
  },
  environments: {
    // Maps for the browser bundle only, without a sourceMappingURL comment: the build uploads them
    // to Sentry and deletes them, so they are never served.
    client: { build: { sourcemap: "hidden" } },
  },
  plugins: [
    devtools(),
    tsconfigPaths({
      projects: ["./tsconfig.json", "./node_modules/@sealant/ui/tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
