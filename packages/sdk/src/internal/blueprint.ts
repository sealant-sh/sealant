/**
 * Lowers the fluent `create({ repository, harness })` options into the existing
 * `createWorkspaceRequestSchema` the control plane accepts — entirely client-side, so the slice needs
 * no contract change. The public `repository` is the SOURCE git repo (it becomes
 * `spec.sources.workspace.url`); the contract's `repository`/`tag` are the OCI push coordinates, which
 * we derive. `customization.enableSealantd` is forced on (it bakes + launches the daemon the run path
 * connects to), the runtime target is pinned to docker (the only bridgeable adapter today), and the
 * foreground is a keepalive so the workspace idles with the daemon up and the harness is exec'd on
 * demand by `run()` rather than launched at boot. `options.credentials`, if present, is lowered via
 * `mapWorkspaceCredentials` (see `./credentials.js`) and folded into `spec.credentials`; the control
 * plane resolves those account references server-side (never secret material over this path).
 */
import { randomUUID } from "node:crypto";

import type { CreateWorkspaceRequest } from "@sealant/api-contracts";

import { SealantError } from "../errors.js";
import type { CreateOptions } from "../types.js";
import type { SealantInternalConfig } from "./config.js";
import { mapWorkspaceCredentials } from "./credentials.js";
import { parseTtlSeconds } from "./duration.js";
import { discoverLinkedWorktreeMetadataMount } from "./linked-worktree.js";

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

export const buildCreateWorkspaceRequest = (
  options: CreateOptions,
  config: SealantInternalConfig,
): { readonly payload: CreateWorkspaceRequest } => {
  if ((options.repository === undefined) === (options.source === undefined)) {
    throw new SealantError(
      "workspaces.create requires exactly one of `repository` (a git remote to clone) or `source` (a caller-owned mount).",
      { code: "invalid_create_options" },
    );
  }
  if (options.source !== undefined && options.ref !== undefined) {
    throw new SealantError("`ref` applies only to `repository` sources, not mounts.", {
      code: "invalid_create_options",
    });
  }
  if (options.os !== undefined && options.baseImage !== undefined) {
    throw new SealantError(
      "workspaces.create accepts either `os` (a managed OS family) or `baseImage` (a custom base image reference), not both.",
      { code: "invalid_create_options" },
    );
  }
  const sourceName = options.repository ?? options.source?.path ?? "workspace";
  const tail =
    sourceName
      .split("/")
      .filter((s) => s.length > 0)
      .pop() ?? sourceName;
  const credentials = mapWorkspaceCredentials(options.credentials);
  const linkedWorktreeMount =
    options.source === undefined ? null : discoverLinkedWorktreeMetadataMount(options.source.path);
  const explicitMounts = options.mounts ?? [];
  const existingMetadataMount =
    linkedWorktreeMount === null
      ? undefined
      : explicitMounts.find((mount) => mount.mountPath === linkedWorktreeMount.mountPath);
  if (
    linkedWorktreeMount !== null &&
    existingMetadataMount !== undefined &&
    (existingMetadataMount.hostPath !== linkedWorktreeMount.hostPath ||
      existingMetadataMount.readOnly !== false)
  ) {
    throw new SealantError(
      `Mount path ${linkedWorktreeMount.mountPath} is required for writable linked-worktree Git metadata and conflicts with an explicit mount.`,
      { code: "linked_worktree_mount_conflict" },
    );
  }
  const mounts = [
    ...explicitMounts,
    ...(linkedWorktreeMount === null || existingMetadataMount !== undefined
      ? []
      : [linkedWorktreeMount]),
  ];
  const toolingPackages = options.packages?.map((id) => ({ id })) ?? [];
  const dockerService = options.services?.docker === true;
  const tooling =
    toolingPackages.length === 0 && !dockerService
      ? undefined
      : {
          ...(toolingPackages.length === 0 ? {} : { packages: toolingPackages }),
          ...(dockerService ? { services: { docker: { enabled: true } } } : {}),
        };
  const spec = {
    version: "1",
    sources: {
      workspace:
        options.repository !== undefined
          ? {
              kind: "git",
              provider: "generic",
              url: toGitUrl(options.repository),
              // Omitted ref = the repository's default branch, resolved by the clone itself.
              ...(options.ref === undefined ? {} : { ref: options.ref }),
            }
          : { kind: "mount", hostPath: options.source?.path },
      ...(mounts.length === 0
        ? {}
        : {
            mounts: mounts.map((mount) => ({
              hostPath: mount.hostPath,
              mountPath: mount.mountPath,
              // Omitted = the blueprint's default (read-only). Only an explicit choice is sent.
              ...(mount.readOnly === undefined ? {} : { readOnly: mount.readOnly }),
            })),
          }),
    },
    harness: { id: options.harness.id },
    customization: { enableSealantd: true },
    target: {
      os:
        options.baseImage !== undefined
          ? { family: "custom", mode: "require", baseImage: options.baseImage }
          : { family: options.os ?? "fedora", mode: "prefer" },
      runtime: { family: "docker", mode: "require" },
    },
    lifecycle: {
      startup: { foreground: { kind: "command", run: "sleep infinity", shell: "bash" } },
    },
    ...(tooling === undefined ? {} : { tooling }),
    ...(credentials === undefined ? {} : { credentials }),
  };

  return {
    payload: {
      ownerUserId: config.hostLocal.ownerUserId,
      registryId: config.hostLocal.registryId,
      repository: sanitizeRepoSlug(tail),
      tag: `sdk-${randomUUID().slice(0, 8)}`,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.ttl === undefined ? {} : { ttlSeconds: parseTtlSeconds(options.ttl) }),
      spec,
    },
  };
};
