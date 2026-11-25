#!/usr/bin/env node
/**
 * Runs after `vite build`. When a Sentry auth token is present, it gives the browser bundle Sentry
 * debug IDs and uploads its source maps under the release the bundle reports
 * (`SENTRY_RELEASE`, also read by vite.config.ts). Then, token or not, it deletes every map from
 * dist/client, so server.mjs can never serve one.
 *
 * Environment: SENTRY_AUTH_TOKEN, or SENTRY_AUTH_TOKEN_FILE naming a file that holds it (the image
 * build mounts it as a BuildKit secret); SENTRY_URL; SENTRY_ORG; SENTRY_RELEASE; SENTRY_PROJECT
 * (default sealant-web). Missing any of them skips the upload; a failed upload warns and the build
 * carries on, because an unreadable stack trace is not worth a failed release.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import SentryCli from "@sentry/cli";

const clientDir = fileURLToPath(new URL("../dist/client", import.meta.url));

const value = (name) => {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw.length === 0 ? undefined : raw;
};

const authToken = () => {
  const direct = value("SENTRY_AUTH_TOKEN");
  if (direct !== undefined) return direct;
  const file = value("SENTRY_AUTH_TOKEN_FILE");
  if (file === undefined || !existsSync(file)) return undefined;
  const fromFile = readFileSync(file, "utf8").trim();
  return fromFile.length === 0 ? undefined : fromFile;
};

const mapFiles = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".map"))
    .map((entry) => join(entry.parentPath, entry.name));

const sentryCli = (args, env) =>
  spawnSync(SentryCli.getPath(), args, { stdio: "inherit", env: { ...process.env, ...env } });

const upload = () => {
  const token = authToken();
  const url = value("SENTRY_URL");
  const org = value("SENTRY_ORG");
  const release = value("SENTRY_RELEASE");
  const project = value("SENTRY_PROJECT") ?? "sealant-web";
  if (token === undefined || url === undefined || org === undefined || release === undefined) {
    console.log(
      "[source-maps] no Sentry upload: SENTRY_AUTH_TOKEN, SENTRY_URL, SENTRY_ORG and SENTRY_RELEASE are not all set.",
    );
    return;
  }

  const env = {
    SENTRY_AUTH_TOKEN: token,
    SENTRY_URL: url,
    SENTRY_ORG: org,
    SENTRY_PROJECT: project,
  };
  for (const args of [
    ["sourcemaps", "inject", clientDir],
    ["sourcemaps", "upload", "--release", release, clientDir],
  ]) {
    const result = sentryCli(args, env);
    if (result.status !== 0) {
      console.log(
        `::warning::[source-maps] sentry-cli ${args.slice(0, 2).join(" ")} failed (exit ${result.status ?? result.signal}); ${release} ships without readable browser stack traces.`,
      );
      return;
    }
  }
  console.log(`[source-maps] uploaded the browser source maps for ${release} to ${project}.`);
};

if (!existsSync(clientDir)) {
  console.error(`[source-maps] ${clientDir} does not exist; run vite build first.`);
  process.exit(1);
}

upload();
const maps = mapFiles(clientDir);
for (const file of maps) rmSync(file);
console.log(`[source-maps] removed ${maps.length} source map(s) from dist/client.`);
