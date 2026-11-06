import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const [destination, bundleDirectory] = process.argv.slice(2);
if (!destination)
  throw new Error("Usage: stage-assets.mjs /absolute/destination [/absolute/verified-bundle]");
const output = resolve(destination);
const source = fileURLToPath(new URL("./", import.meta.url));
const lock = JSON.parse(await readFile(new URL("./asset-lock.json", import.meta.url), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(output, { mode: 0o700 });
for (const file of lock.files) {
  const bytes = await readFile(resolve(source, file.name));
  if (hash(bytes) !== file.sha256) throw new Error("Native asset mismatch: " + file.name);
  await writeFile(resolve(output, file.name), bytes, { mode: 0o644 });
}
if (bundleDirectory) {
  for (const name of [
    "source-index.json",
    "platform-manifest.json",
    "sealantd",
    "socat",
    "control-relay.cjs",
  ])
    await copyFile(resolve(bundleDirectory, name), resolve(output, name));
} else {
  const pin = JSON.parse(
    await readFile(new URL("../src/images/boat/runtime-pin.json", import.meta.url), "utf8"),
  );
  const repository = "sealant-sh/sealantd-next";
  const { token } = await (
    await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`)
  ).json();
  const download = async (kind, sha) => {
    const response = await fetch(`https://ghcr.io/v2/${repository}/${kind}/sha256:${sha}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json",
      },
    });
    if (!response.ok) throw new Error("Pinned runtime acquisition failed: " + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== sha) throw new Error("Pinned OCI digest mismatch");
    return bytes;
  };
  const index = await download("manifests", pin.index);
  const manifest = await download("manifests", pin.manifest);
  await writeFile(resolve(output, "source-index.json"), index);
  await writeFile(resolve(output, "platform-manifest.json"), manifest);
  const { gunzipSync } = await import("node:zlib");
  for (const layer of JSON.parse(manifest).layers) {
    const compressed = await download("blobs", layer.digest.slice(7));
    const tar = gunzipSync(compressed);
    for (let offset = 0; offset + 512 <= tar.length; ) {
      const name = tar
        .subarray(offset, offset + 100)
        .toString()
        .split(String.fromCharCode(0))[0];
      const size = Number.parseInt(
        tar
          .subarray(offset + 124, offset + 136)
          .toString()
          .split(String.fromCharCode(0))[0]
          .trim() || "0",
        8,
      );
      const type = tar[offset + 156];
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
        throw new Error("Invalid pinned layer");
      if (["usr/local/bin/sealantd", "usr/local/bin/socat"].includes(name.replace(/^\.\//, ""))) {
        if (type !== 0 && type !== 48) throw new Error("Pinned binary is not a regular file");
        await writeFile(
          resolve(output, name.split("/").at(-1)),
          tar.subarray(offset + 512, offset + 512 + size),
        );
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  }
  await build({
    absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)),
    entryPoints: [resolve(source, "control-relay.mjs")],
    outfile: resolve(output, "control-relay.cjs"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    packages: "bundle",
    logLevel: "silent",
  });
}
const pin = JSON.parse(
  await readFile(new URL("../src/images/boat/runtime-pin.json", import.meta.url), "utf8"),
);
for (const [name, expected] of Object.entries({
  "source-index.json": pin.index,
  "platform-manifest.json": pin.manifest,
  sealantd: pin.sealantd,
  socat: pin.socat,
  "control-relay.cjs": lock.relay,
})) {
  if (hash(await readFile(resolve(output, name))) !== expected)
    throw new Error("Native runtime mismatch: " + name);
  await chmod(resolve(output, name), name.endsWith(".json") ? 0o644 : 0o755);
}
await copyFile(new URL("./asset-lock.json", import.meta.url), resolve(output, "asset-lock.json"));
await writeFile(resolve(output, "runtime-pin.json"), JSON.stringify(pin) + "\n", { mode: 0o644 });
console.log(JSON.stringify({ staged: output, files: lock.files.length + 7 }));
await mkdir(resolve(output, "../dist"), { recursive: true });
await build({
  entryPoints: [resolve(source, "packaged-check.ts")],
  outfile: resolve(output, "../dist/boat-assets-check.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  logLevel: "silent",
});
