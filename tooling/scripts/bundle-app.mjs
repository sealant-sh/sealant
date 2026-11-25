/**
 * Bundle a Sealant app server (api / worker / ssh-gateway) into a single self-contained JS file with
 * esbuild, so production images run plain `node dist/index.js` — no tsx, no monorepo install, no
 * source. Run from the app directory: `node ../../tooling/scripts/bundle-app.mjs`.
 *
 * BUNDLE_EXTERNAL (comma-separated) keeps native/unbundleable deps external (e.g. ssh2 for the gateway);
 * those must be installed in the runtime image.
 *
 * BUNDLE_ENTRIES (comma-separated, default src/index.ts) bundles extra entrypoints — each lands in
 * dist/ under its basename (src/migrate.ts -> dist/migrate.js).
 *
 * SENTRY_RELEASE, when set, is written into the bundle as the release its errors report
 * (`bundledRelease()` in @sealant/observability), so a parent process's own SENTRY_RELEASE cannot
 * relabel it. Each entry is also stamped with a Sentry debug ID, in the code and in its source map,
 * so the map uploaded from CI matches this exact file whatever path it runs from.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { basename } from "node:path";

import { build } from "esbuild";

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

const entryPoints = (process.env.BUNDLE_ENTRIES ?? "src/index.ts")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const release = process.env.SENTRY_RELEASE?.trim() ?? "";

/**
 * What Sentry's debug-ID injection writes: it records, for the stack of this file's first line, the
 * ID its source map carries. The SDK reads `_sentryDebugIds` to name the map for each frame.
 */
const debugIdSnippet = (debugId) =>
  `!function(){try{var e=globalThis,n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="${debugId}",e._sentryDebugIdIdentifier="sentry-dbid-${debugId}")}catch(e){}}();`;

/**
 * Stands in for the debug ID while esbuild builds: it has the ID's length, so swapping the real one
 * in afterwards moves no column the source map points at.
 */
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

/** A UUID-shaped ID from the built file's content: the same code always gets the same ID. */
const contentDebugId = (code) => {
  const hex = createHash("sha256").update(code).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// One build per entry: each file gets a debug ID of its own.
for (const entry of entryPoints) {
  await bundle(entry, PLACEHOLDER_ID);
  const out = `dist/${basename(entry).replace(/\.[cm]?tsx?$/, "")}.js`;
  const code = await readFile(out, "utf8");
  const debugId = contentDebugId(code);
  await writeFile(out, code.replaceAll(PLACEHOLDER_ID, debugId));
  const map = JSON.parse(await readFile(`${out}.map`, "utf8"));
  await writeFile(`${out}.map`, JSON.stringify({ ...map, debugId, debug_id: debugId }));
}

async function bundle(entry, debugId) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    // Entries land in dist/ by basename (outbase is the entries' common ancestor, src/).
    outdir: "dist",
    sourcemap: true,
    // Escape non-ASCII characters: V8 keeps a script's source resident for its whole lifetime and
    // stores it two bytes per character as soon as one character is outside Latin-1. A pure-ASCII
    // bundle costs 1 byte/char (12 MiB instead of 24 MiB for the API).
    charset: "ascii",
    // Comments are the only place non-ASCII survives `charset: "ascii"` (dependency prose is full of
    // curly quotes and dashes), and one such character makes V8 store the whole script two-byte.
    // Whitespace minification drops them; `lineLimit` keeps line numbers meaningful in stack traces.
    minifyWhitespace: true,
    lineLimit: 160,
    legalComments: "none",
    external,
    plugins: [tsJsResolvePlugin],
    // ESM output that some CJS deps (and code expecting require/__dirname) still need.
    banner: {
      js: [
        debugIdSnippet(debugId),
        "import { createRequire as __createRequire } from 'node:module';",
        "import { fileURLToPath as __fileURLToPath } from 'node:url';",
        "import { dirname as __pathDirname } from 'node:path';",
        "const require = __createRequire(import.meta.url);",
        "const __filename = __fileURLToPath(import.meta.url);",
        "const __dirname = __pathDirname(__filename);",
      ].join("\n"),
    },
    footer: { js: `//# debugId=${debugId}` },
    ...(release === ""
      ? {}
      : { define: { "process.env.SEALANT_BUNDLED_SENTRY_RELEASE": JSON.stringify(release) } }),
    logLevel: "info",
  });
}
