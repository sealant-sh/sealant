import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

delete process.env.BOAT_API_KEY;
const output = process.argv[2];
if (!output) {
  process.stderr.write("Usage: node build-relay.mjs /absolute/output/control-relay.cjs\n");
  process.exit(2);
}
await build({
  entryPoints: [fileURLToPath(new URL("./control-relay.mjs", import.meta.url))],
  outfile: resolve(output),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  packages: "bundle",
  logLevel: "silent",
});
