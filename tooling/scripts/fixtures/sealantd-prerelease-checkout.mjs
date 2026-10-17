// A checkout that pins a sealantd prerelease the way main does between sealantd releases
// (tooling/scripts/pin-sealantd.mjs with a -next version), with check-release-pins.mjs copied in at
// its own path, so the script and release.yml's pins step run against it as written.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NEXT_IMAGE = `ghcr.io/sealant-sh/sealantd-next:0.20.0-next.157@sha256:${"b".repeat(64)}`;

const runtime = {
  "@sealant/runtime-client": "npm:@sealant/runtime-client-next@0.20.0-next.157",
  "@sealant/runtime-protocol": "npm:@sealant/runtime-protocol-next@0.20.0-next.157",
};

/** The files of the checkout: a path to its text, or to a value written as JSON. */
export const prereleaseFiles = () => ({
  "packages/workspaces/src/buildkit/buildkit-builder.ts": `export const SEALANTD_IMAGE =\n  process.env["SEALANT_SEALANTD_IMAGE"] ??\n  "${NEXT_IMAGE}";\n`,
  "apps/cf-bridge/Dockerfile": `FROM docker.io/cloudflare/sandbox:0.4.0\nCOPY --chmod=755 --from=${NEXT_IMAGE} /usr/local/bin/sealantd /usr/local/bin/sealantd\n`,
  "apps/ssh-gateway/package.json": { name: "@sealant/ssh-gateway", dependencies: runtime },
  "packages/telemetry/package.json": { name: "@sealant/telemetry", dependencies: runtime },
  "packages/workspaces/package.json": { name: "@sealant/workspaces", dependencies: runtime },
  "packages/sdk/package.json": {
    name: "@sealant/sdk",
    dependencies: { "@sealant/api-contracts": "workspace:*" },
  },
  "packages/api-contracts/package.json": { name: "@sealant/api-contracts" },
  "pnpm-lock.yaml": [
    "packages:",
    "  '@sealant/runtime-client-next@0.20.0-next.157':",
    "    resolution: {integrity: sha512-x}",
    "  '@sealant/runtime-protocol-next@0.20.0-next.157':",
    "    resolution: {integrity: sha512-y}",
    "",
  ].join("\n"),
});

/** What check-release-pins.mjs reports for prereleaseFiles(), in its order. */
export const PRERELEASE_PROBLEMS = [
  `packages/workspaces/src/buildkit/buildkit-builder.ts pins ${NEXT_IMAGE}, not a release by digest.`,
  `apps/cf-bridge/Dockerfile pins ${NEXT_IMAGE}, not a release by digest.`,
  ...[
    "apps/ssh-gateway/package.json",
    "packages/telemetry/package.json",
    "packages/workspaces/package.json",
  ].flatMap((file) => [
    `${file} depends on @sealant/runtime-client@npm:@sealant/runtime-client-next@0.20.0-next.157.`,
    `${file} depends on @sealant/runtime-protocol@npm:@sealant/runtime-protocol-next@0.20.0-next.157.`,
  ]),
  "pnpm-lock.yaml resolves @sealant/runtime-client-next@0.20.0-next.157.",
  "pnpm-lock.yaml resolves @sealant/runtime-protocol-next@0.20.0-next.157.",
];

/** The checkout's directory, removed after the test; `files` replaces or adds files. */
export const prereleaseCheckout = (t, files = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), "core-release-pins-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({ ...prereleaseFiles(), ...files })) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(
      path.join(directory, file),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
    );
  }
  mkdirSync(path.join(directory, "tooling/scripts"), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("../check-release-pins.mjs", import.meta.url)),
    path.join(directory, "tooling/scripts/check-release-pins.mjs"),
  );
  return directory;
};
