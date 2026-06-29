/**
 * Lowers the fluent `create({ repository, harness })` options into the existing
 * `createSandboxRequestSchema` the control plane accepts — entirely client-side, so the slice needs
 * no contract change. The public `repository` is the SOURCE git repo (it becomes
 * `spec.sources.sandbox.url`); the contract's `repository`/`tag` are the OCI push coordinates, which
 * we derive. `customization.enableSealantd` is forced on (it bakes + launches the daemon the run path
 * connects to), the runtime target is pinned to docker (the only bridgeable adapter today), and the
 * foreground is a keepalive so the sandbox idles with the daemon up and the harness is exec'd on
 * demand by `run()` rather than launched at boot.
 */
import { randomUUID } from "node:crypto";

import type { CreateSandboxRequest } from "@sealant/api-contracts";

import type { CreateOptions } from "../types.js";
import type { SealantInternalConfig } from "./config.js";
import type { ForwardPlan } from "./host-forward.js";

const EMPTY_FORWARD: ForwardPlan = { env: {}, setupSteps: [] };

const sanitizeRepoSlug = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "repo";
};

const toGitUrl = (repository: string): string => {
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(repository)) {
    return repository;
  }
  return `https://${repository}.git`;
};

/**
 * Build the optional `spec.runtime` fragment: forwarded host env (`forward`/`env`) and stored-credential
 * references (`use` → `runtime.credentialRefs`, each `sealant-credential:<id>`). Omitted entirely when
 * neither is present so existing specs render unchanged.
 */
const buildRuntimeSpec = (
  options: CreateOptions,
  forward: ForwardPlan,
): { runtime?: { env?: Record<string, string>; credentialRefs?: Array<{ ref: string }> } } => {
  const credentialRefs = (options.use ?? []).map((id) => ({ ref: `sealant-credential:${id}` }));
  const runtime: { env?: Record<string, string>; credentialRefs?: Array<{ ref: string }> } = {
    ...(Object.keys(forward.env).length === 0 ? {} : { env: { ...forward.env } }),
    ...(credentialRefs.length === 0 ? {} : { credentialRefs }),
  };
  return Object.keys(runtime).length === 0 ? {} : { runtime };
};

export const buildCreateSandboxRequest = (
  options: CreateOptions,
  config: SealantInternalConfig,
  // Forwarded host logins (scoped tokens + base64 credential blobs + the boot steps that decode them),
  // already captured by `prepareForward`. The env is lowered onto `spec.runtime.env` (the worker passes
  // it straight to `docker run -e`); the boot steps onto `spec.lifecycle.setup` (sealantd runs them
  // before the harness). No contract/worker change is needed to carry either.
  forward: ForwardPlan = EMPTY_FORWARD,
): { readonly payload: CreateSandboxRequest } => {
  const tail =
    options.repository
      .split("/")
      .filter((s) => s.length > 0)
      .pop() ?? options.repository;
  const spec = {
    version: "1",
    sources: {
      sandbox: {
        kind: "git",
        provider: "generic",
        url: toGitUrl(options.repository),
        ref: options.ref ?? "main",
      },
    },
    harness: { id: options.harness.id },
    customization: { enableSealantd: true },
    target: {
      os: { family: options.os ?? "fedora", mode: "prefer" },
      runtime: { family: "docker", mode: "require" },
    },
    lifecycle: {
      // Boot steps that materialize forwarded credential files into the sandbox before the harness runs.
      ...(forward.setupSteps.length === 0 ? {} : { setup: forward.setupSteps.map((step) => ({ ...step })) }),
      startup: { foreground: { kind: "command", run: "sleep infinity", shell: "bash" } },
    },
    ...(options.packages === undefined || options.packages.length === 0
      ? {}
      : { tooling: { packages: options.packages.map((id) => ({ id })) } }),
    ...buildRuntimeSpec(options, forward),
  };

  return {
    payload: {
      ownerUserId: config.hostLocal.ownerUserId,
      registryId: config.hostLocal.registryId,
      repository: sanitizeRepoSlug(tail),
      tag: `sdk-${randomUUID().slice(0, 8)}`,
      ...(options.name === undefined ? {} : { name: options.name }),
      spec,
    },
  };
};
