import {
  ResourceInstanceId,
  ResourceInstanceKey,
  ResourceWorktreeKey,
  resourceInstanceSpecSchema,
  type ResourceInstanceSpec,
} from "@sealant/api-contracts";
import type { LinkedExecutor, ResourceInstanceRecord } from "@sealant/db";
import { Schema } from "effect";

export const DOMAIN = "rdm:11111111-2222-4333-8444-555555555555";
export const POSTGRES_IMAGE = `postgres:18@sha256:${"b".repeat(64)}`;

export const postgresSpec = (
  overrides: Partial<Record<keyof ResourceInstanceSpec, unknown>> = {},
): ResourceInstanceSpec =>
  Schema.decodeUnknownSync(resourceInstanceSpecSchema)({
    alias: "db",
    worktreeKey: null,
    image: POSTGRES_IMAGE,
    command: null,
    env: { POSTGRES_HOST_AUTH_METHOD: "trust", PGDATA: "/var/lib/postgresql/18/docker" },
    volumes: [{ name: "data", mountPath: "/var/lib/postgresql" }],
    limits: { cpuMillicores: 1500, memoryBytes: 1024 * 1024 * 1024 },
    ready: { kind: "exec", argv: ["pg_isready", "-U", "postgres"], user: "postgres" },
    idleStopAfterSeconds: 1800,
    ...overrides,
  });

/** An instance row as the repository answers it. */
export const instanceRecord = (
  overrides: Partial<ResourceInstanceRecord> & { readonly uuid?: string } = {},
): ResourceInstanceRecord => {
  const { uuid = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", ...rest } = overrides;
  return {
    id: ResourceInstanceId.make(`rin:${uuid}`),
    resourceDomainId: DOMAIN,
    key: ResourceInstanceKey.make("db"),
    spec: postgresSpec(),
    specDigest: `sha256:${"c".repeat(64)}`,
    desired: "running",
    stopReason: null,
    observed: { kind: "not-started" },
    observedAt: new Date("2026-10-31T12:00:00.000Z"),
    volumes: [],
    startedAt: null,
    lastReachedAt: null,
    createdAt: new Date("2026-10-31T12:00:00.000Z"),
    archivedAt: null,
    ...rest,
  };
};

export const linkedExecutor = (
  executor: string,
  worktreeKey: string,
  resourceDomainId = DOMAIN,
): LinkedExecutor => ({
  workspaceId: `ws-${executor}`,
  resourceDomainId,
  worktreeKey: ResourceWorktreeKey.make(worktreeKey),
  executor,
});
