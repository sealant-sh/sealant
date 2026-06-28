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

export const buildCreateSandboxRequest = (
  options: CreateOptions,
  config: SealantInternalConfig,
): { readonly payload: CreateSandboxRequest } => {
  const tail = options.repository.split("/").filter((s) => s.length > 0).pop() ?? options.repository;
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
      startup: { foreground: { kind: "command", run: "sleep infinity", shell: "bash" } },
    },
    ...(options.packages === undefined || options.packages.length === 0
      ? {}
      : { tooling: { packages: options.packages.map((id) => ({ id })) } }),
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
