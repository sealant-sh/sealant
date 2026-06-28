/**
 * Bundle a Sealant app server (api / worker / ssh-gateway) into a single self-contained JS file with
 * esbuild, so production images run plain `node dist/index.js` — no tsx, no monorepo install, no
 * source. Run from the app directory: `node ../../tooling/scripts/bundle-app.mjs`.
 *
 * BUNDLE_EXTERNAL (comma-separated) keeps native/unbundleable deps external (e.g. ssh2 for the gateway);
 * those must be installed in the runtime image.
 */
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// This repo uses NodeNext-style `.js` import specifiers that point at `.ts` source files. esbuild does
// not rewrite `.js` -> `.ts`, so map relative `./foo.js` (and `.jsx`) imports to the real `.ts`/`.tsx`.
const tsJsResolvePlugin = {
  name: "ts-js-resolve",
  setup(b) {
    b.onResolve({ filter: /^\.{1,2}\/.*\.jsx?$/ }, (args) => {
      const base = resolve(args.resolveDir, args.path);
      for (const candidate of [base.replace(/\.jsx?$/, ".ts"), base.replace(/\.jsx?$/, ".tsx")]) {
        if (existsSync(candidate)) {
          return { path: candidate };
        }
      }
      return undefined;
    });
  },
};

const external = (process.env.BUNDLE_EXTERNAL ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/index.js",
  sourcemap: true,
  external,
  plugins: [tsJsResolvePlugin],
  // ESM output that some CJS deps (and code expecting require/__dirname) still need.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});
