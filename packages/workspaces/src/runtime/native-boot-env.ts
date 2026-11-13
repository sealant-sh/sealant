import type { WorkspacePublication } from "@sealant/validators";

import { getHarnessIntegration } from "../harness/integrations.js";
import {
  CAPTURE_HARNESS_HOME_ENV,
  CAPTURE_SOURCE_ONLY_ENV,
  captureOwnerMapEnv,
  captureSourceEnv,
} from "./capture-source.js";
import type { RuntimeLaunch } from "./runtime-adapter.js";

interface BootLifecycleStepJson {
  readonly run: string;
  readonly shell: "sh" | "bash";
  readonly workingDirectory?: string;
}

const toBootLifecycleStepJson = (step: {
  readonly run: string;
  readonly shell: "sh" | "bash";
  readonly workingDirectory?: string | undefined;
}): BootLifecycleStepJson => ({
  run: step.run,
  shell: step.shell,
  ...(step.workingDirectory === undefined ? {} : { workingDirectory: step.workingDirectory }),
});

/**
 * The `sealantd boot` process environment for a launch, in emission order (later wins, matching
 * the Docker adapter's `-e` ordering): caller env, source facts, adapter-owned boot facts, the
 * blueprint's launch env, launch-material paths, then the secret-bearing lanes (clone auth,
 * worker-resolved platform env, credential env). A native image is generic — one image
 * serves every blueprint — so lifecycle and harness facts that the Docker builder bakes into an
 * image travel here instead. Pure; pinned by the golden test.
 */
export const nativeBootEnv = (
  input: Omit<RuntimeLaunch<WorkspacePublication>, "publication">,
  options: {
    readonly secretEnvFile: boolean;
    readonly dotfiles: boolean;
    readonly secretEnvFilePath?: string;
    readonly dotfilesArchivePath?: string;
    /**
     * The terminate hook's flush budget (`flushTimeoutMs`): a daemon stopped with the VM bounds
     * its shutdown final flush inside it and exits 75 rather than being cut off.
     */
    readonly stopGraceMs?: number;
  },
): Record<string, string> => {
  const { blueprint } = input;
  const entries: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(blueprint.runtime.userEnv ?? {})) {
    entries.push([key, value]);
  }
  const source = blueprint.sources.workspace;
  if (source.kind === "capture") {
    entries.push(
      ...captureSourceEnv(source, {
        ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
        launchId: input.launchId,
      }),
    );
  } else if (source.kind === "git") {
    // `git` is sealant's blueprint term; pinned sealantd v0.18.2 names this wire mode `clone`.
    entries.push(["SEALANT_WORKSPACE_SOURCE", "clone"]);
    entries.push(["SEALANT_WORKSPACE_REPO_URL", source.url]);
    if (source.ref !== undefined) {
      entries.push(["SEALANT_WORKSPACE_REPO_REF", source.ref]);
    }
  }
  entries.push(["SEALANT_WORKSPACE_ROOT", blueprint.runtime.workspaceRoot]);
  entries.push(["SEALANT_WORKING_DIRECTORY", blueprint.runtime.workingDirectory]);
  entries.push(["SEALANT_CONTROL_SOCKET", "/run/sealant/control.sock"]);
  entries.push(["SEALANT_OCI_RUNTIME", blueprint.runtime.ociRuntime]);
  const harness = getHarnessIntegration(blueprint.harness.id);
  if (harness !== undefined) {
    entries.push(["SEALANT_HARNESS_BANNER", `Starting ${blueprint.harness.id} workspace`]);
    entries.push(["SEALANT_HARNESS_LAUNCH_COMMAND", harness.launchCommand]);
  }
  entries.push([
    "SEALANT_LIFECYCLE_SETUP_JSON",
    JSON.stringify(blueprint.lifecycle.setup.map(toBootLifecycleStepJson)),
  ]);
  entries.push([
    "SEALANT_LIFECYCLE_STARTUP_JSON",
    JSON.stringify(blueprint.lifecycle.startup.steps.map(toBootLifecycleStepJson)),
  ]);
  const foreground = blueprint.lifecycle.startup.foreground;
  if (foreground.kind === "command") {
    entries.push([
      "SEALANT_FOREGROUND_RUN_JSON",
      JSON.stringify(toBootLifecycleStepJson(foreground)),
    ]);
  }
  for (const [key, value] of Object.entries(blueprint.runtime.env)) {
    if (
      (source.kind === "capture" &&
        source.harnessHome !== undefined &&
        key === CAPTURE_HARNESS_HOME_ENV) ||
      CAPTURE_SOURCE_ONLY_ENV.has(key)
    ) {
      continue;
    }
    entries.push([key, value]);
  }
  if (options.secretEnvFile) {
    entries.push([
      "SEALANT_SECRET_ENV_FILE",
      options.secretEnvFilePath ?? "/run/sealant/secrets/env.json",
    ]);
  }
  if (options.dotfiles) {
    entries.push([
      "SEALANT_DOTFILES_ARCHIVE_DIR",
      options.dotfilesArchivePath ?? "/run/sealant/dotfiles",
    ]);
  }
  // Clone auth is read by the daemon's own boot config, so it cannot travel in the secret env
  // file (which rejects SEALANT_* names); it is process env, delivered inside the same TLS push.
  const auth = input.workspaceCloneAuth;
  if (auth?.type === "http-token") {
    entries.push(["SEALANT_WORKSPACE_HTTP_USERNAME", auth.username]);
    entries.push(["SEALANT_WORKSPACE_HTTP_TOKEN", auth.token]);
  }
  for (const [key, value] of Object.entries(input.platformEnv ?? {})) {
    entries.push([key, value]);
  }
  for (const [key, value] of Object.entries(input.credentialEnv ?? {})) {
    entries.push([key, value]);
  }
  // Service-owned and last-wins over every plaintext lane. The v2 agent pins the same five values
  // before boot, and both sealant and the agent reject them in secretEnvJson.
  if (blueprint.tooling.services?.docker?.enabled === true) {
    entries.push(["DOCKER_HOST", "unix:///run/docker/docker.sock"]);
    entries.push(["DOCKER_CONTEXT", ""]);
    entries.push(["DOCKER_TLS_CERTDIR", ""]);
    entries.push(["DOCKER_TLS_VERIFY", ""]);
    entries.push(["DOCKER_CERT_PATH", ""]);
  }
  // The capture owner map after every lane, so nothing overrides it (`captureOwnerMapEnv`).
  entries.push(...captureOwnerMapEnv(source));
  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    env[key] = value;
  }
  return env;
};
