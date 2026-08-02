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
 *
 * Any consumer that bundles the SDK needs this: apps/api (inference) and apps/worker (the claude
 * session keep-fresh sweeper — its refresh ping spawns the same CLI). A missing platform package
 * fails resolution here, aborting the image build for that arch instead of failing per-sweep at
 * runtime.
 */
const [appDir, outDir] = process.argv.slice(2);
if (!appDir || !outDir) {
  throw new Error("usage: node tooling/scripts/stage-agent-cli.mjs <app-dir> <out-dir>");
}

const appRequire = createRequire(join(process.cwd(), appDir, "package.json"));
const sdkRequire = createRequire(appRequire.resolve("@anthropic-ai/claude-agent-sdk"));
const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const packageDir = dirname(sdkRequire.resolve(`${platformPackage}/claude`));
const destination = join(outDir, "node_modules", platformPackage);

mkdirSync(dirname(destination), { recursive: true });
cpSync(packageDir, destination, { recursive: true, dereference: true });
console.log(`staged ${platformPackage} (via ${appDir}) -> ${destination}`);
