import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Stage the Claude Agent SDK's platform package (the vendored `claude` binary) for a runtime image.
 *
 * The SDK resolves `@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude` with require() relative
 * to wherever its code runs from — in production images that is the esbuild bundle at dist/index.js,
 * so the package must sit in a node_modules resolvable from dist/, at exactly the version the bundled
 * SDK shipped with. Run from the repo root in the builder stage (where pnpm installed the lockfile
 * version), then COPY `<out-dir>/node_modules` next to dist/ in the runtime stage.
 */
const outDir = process.argv[2];
if (!outDir) {
  throw new Error("usage: node tooling/scripts/stage-agent-cli.mjs <out-dir>");
}

const apiRequire = createRequire(join(process.cwd(), "apps/api/package.json"));
const sdkRequire = createRequire(apiRequire.resolve("@anthropic-ai/claude-agent-sdk"));
const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const packageDir = dirname(sdkRequire.resolve(`${platformPackage}/claude`));
const destination = join(outDir, "node_modules", platformPackage);

mkdirSync(dirname(destination), { recursive: true });
cpSync(packageDir, destination, { recursive: true, dereference: true });
console.log(`staged ${platformPackage} -> ${destination}`);
