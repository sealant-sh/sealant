import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Stage the Codex CLI (`@openai/codex`) for a runtime image, sibling of stage-agent-cli.mjs.
 *
 * The codex inference engine spawns `@openai/codex/bin/codex.js` with require() relative to
 * wherever its code runs from — in production images that is the esbuild bundle at dist/index.js —
 * and the launcher in turn resolves `@openai/codex-{platform}-{arch}` (an npm alias whose package
 * carries the vendored native binary under vendor/). Both packages must therefore sit in a
 * node_modules resolvable from dist/, at exactly the versions pnpm installed. Run from the repo
 * root in the builder stage, then COPY `<out-dir>/node_modules` next to dist/ in the runtime
 * stage. A missing platform package fails resolution here, aborting the image build for that arch
 * instead of failing per-exchange at runtime.
 */
const [appDir, outDir] = process.argv.slice(2);
if (!appDir || !outDir) {
  throw new Error("usage: node tooling/scripts/stage-codex-cli.mjs <app-dir> <out-dir>");
}

const appRequire = createRequire(join(process.cwd(), appDir, "package.json"));
const launcherPackageDir = dirname(appRequire.resolve("@openai/codex/package.json"));
const codexRequire = createRequire(join(launcherPackageDir, "package.json"));
const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
const platformPackageDir = dirname(codexRequire.resolve(`${platformPackage}/package.json`));

for (const [name, packageDir] of [
  ["@openai/codex", launcherPackageDir],
  [platformPackage, platformPackageDir],
]) {
  const destination = join(outDir, "node_modules", name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(packageDir, destination, { recursive: true, dereference: true });
  console.log(`staged ${name} (via ${appDir}) -> ${destination}`);
}
