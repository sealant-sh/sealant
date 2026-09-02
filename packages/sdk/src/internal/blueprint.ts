/**
 * Lowers the fluent `create({ repository, harness })` options into the existing
 * `createWorkspaceRequestSchema` the control plane accepts — entirely client-side, so the slice needs
 * no contract change. The public `repository` is the SOURCE git repo (it becomes
 * `spec.sources.workspace.url`); the contract's `repository`/`tag` name the create for the build
 * job's own records — the worker publishes the image under plan-keyed coordinates (one repository
 * per OS family, one tag per plan hash), so this name never reaches the registry — and
 * we derive. `customization.enableSealantd` is forced on (it bakes + launches the daemon the run path
 * connects to), the runtime target is `auto` (the deployment's default adapter — Docker on self-host, Kubernetes
 * when the worker is configured for a cluster), and the
 * foreground is a keepalive so the workspace idles with the daemon up and the harness is exec'd on
 * demand by `run()` rather than launched at boot. `options.credentials`, if present, is lowered via
 * `mapWorkspaceCredentials` (see `./credentials.js`) and folded into `spec.credentials`; the control
 * plane resolves those account references server-side (never secret material over this path).
 */
import { randomUUID } from "node:crypto";

import type { CreateWorkspaceRequest } from "@sealant/api-contracts";
import {
  formatWorkspaceEnvIssue,
  parseWorkspaceEnv,
  parseWorkspaceSecretEnv,
} from "@sealant/api-contracts/workspace-environment";

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
  if (options.baseImage !== undefined && options.dotfiles !== undefined) {
    throw new SealantError(
      "`dotfiles` is not supported with `baseImage`: custom bases guarantee only a POSIX shell, so the dotfiles managers are not provisioned.",
      { code: "invalid_create_options" },
    );
  }
  if (options.baseImage !== undefined && options.shell !== undefined && options.shell !== "bash") {
    throw new SealantError(
      "`shell` is not supported with `baseImage`: custom bases run /bin/sh and the login shell cannot be switched.",
      { code: "invalid_create_options" },
    );
  }
  if (
    options.dotfiles !== undefined &&
    options.dotfiles.repository === undefined &&
    (options.dotfiles.archives === undefined || options.dotfiles.archives.length === 0)
  ) {
    throw new SealantError(
      "`dotfiles` requires a `repository`, at least one entry in `archives`, or both.",
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
  const dotfilesRepository = options.dotfiles?.repository;
  const dotfilesArchives = options.dotfiles?.archives ?? [];
  // Client-side rejection with the exact policy the control plane re-applies on parse: same
  // module, same messages, so a bad name fails here instead of as an opaque 400.
  const envResult = options.env === undefined ? undefined : parseWorkspaceEnv(options.env);
  if (envResult !== undefined && !envResult.ok) {
    throw new SealantError(
      `workspaces.create \`env\` was rejected: ${envResult.issues
        .map(formatWorkspaceEnvIssue)
        .join("; ")}`,
      { code: "invalid_workspace_env" },
    );
  }
  const userEnv = envResult === undefined ? undefined : envResult.env;
  const secretEnvResult =
    options.secretEnv === undefined ? undefined : parseWorkspaceSecretEnv(options.secretEnv);
  if (secretEnvResult !== undefined && !secretEnvResult.ok) {
    throw new SealantError(
      `workspaces.create \`secretEnv\` was rejected: ${secretEnvResult.issues
        .map(formatWorkspaceEnvIssue)
        .join("; ")}`,
      { code: "invalid_workspace_secret_env" },
    );
  }
  // Secrets ride the request TOP LEVEL, never the spec: the spec is the durable, API-visible
  // blueprint; the transient channel is a separate field the control plane seals until launch.
  const secretEnv =
    secretEnvResult === undefined || Object.keys(secretEnvResult.env).length === 0
      ? undefined
      : secretEnvResult.env;
  // One `runtime` object for every runtime-scoped field: two conditional `runtime:` spreads in the
  // spec literal would let the later one silently clobber the earlier.
  const runtime = {
    ...(dotfilesArchives.length === 0
      ? {}
      : {
          dotfilesArchives: dotfilesArchives.map((archive) => ({
            data: archive.data,
            ...(archive.manager === undefined ? {} : { manager: archive.manager }),
            ...(archive.target === undefined ? {} : { target: archive.target }),
            ...(archive.bootstrap === undefined ? {} : { bootstrap: archive.bootstrap }),
            ...(archive.bootstrapCommand === undefined
              ? {}
              : { bootstrapCommand: archive.bootstrapCommand }),
          })),
        }),
    ...(userEnv === undefined || Object.keys(userEnv).length === 0 ? {} : { userEnv }),
    ...(options.envFrom === undefined || options.envFrom.length === 0
      ? {}
      : { envFrom: options.envFrom.map(({ kind, name }) => ({ kind, name })) }),
    ...(options.kubernetes?.serviceAccountName === undefined
      ? {}
      : { kubernetes: { serviceAccountName: options.kubernetes.serviceAccountName } }),
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
      ...(dotfilesRepository === undefined
        ? {}
        : {
            inputs: [
              {
                id: "dotfiles",
                kind: "git",
                purpose: "dotfiles",
                provider: "generic",
                url: toGitUrl(dotfilesRepository.url),
                // Omitted ref = the remote's default branch — never assumed to be `main`.
                ...(dotfilesRepository.ref === undefined ? {} : { ref: dotfilesRepository.ref }),
              },
            ],
          }),
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
    customization: {
      enableSealantd: true,
      ...(options.shell === undefined ? {} : { defaultShell: options.shell }),
      // The repository path's knobs live at customization level; archives carry their own.
      ...(dotfilesRepository?.manager === undefined
        ? {}
        : { dotfilesManager: dotfilesRepository.manager }),
      ...(dotfilesRepository?.bootstrap === undefined
        ? {}
        : { dotfilesBootstrap: dotfilesRepository.bootstrap }),
      ...(dotfilesRepository?.bootstrapCommand === undefined
        ? {}
        : { dotfilesBootstrapCommand: dotfilesRepository.bootstrapCommand }),
    },
    ...(Object.keys(runtime).length === 0 ? {} : { runtime }),
    target: {
      os:
        options.baseImage !== undefined
          ? { family: "custom", mode: "require", baseImage: options.baseImage }
          : { family: options.os ?? "fedora", mode: "prefer" },
      // `auto` = the deployment's DEFAULT_RUNTIME_ADAPTER. SDK callers don't know (and must not
      // care) whether the control plane runs workspaces as containers or Pods.
      runtime: { family: "auto", mode: "prefer" },
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
      ...(secretEnv === undefined ? {} : { secretEnv }),
    },
  };
};
