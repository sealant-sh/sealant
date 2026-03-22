import { desc, eq, inArray } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
import {
  sandboxRuntimeInstances,
  type NewSandboxRuntimeInstance,
  type SandboxRuntimeInstance,
  type SandboxRuntimeInstanceStatus,
} from "../schema.js";

export interface UpsertSandboxRuntimeInstanceInput {
  readonly runId: string;
  readonly status: SandboxRuntimeInstanceStatus;
  readonly adapter?: "docker" | "k8s" | "k3s";
  readonly resourceId?: string;
  readonly reference?: string;
  readonly endpoint?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly launchedAt?: Date;
  readonly finishedAt?: Date;
}

export const createSandboxRuntimeInstanceRepository = (client: DatabaseClient) => {
  const { db } = client;

  const upsertRuntimeInstance = async (
    input: UpsertSandboxRuntimeInstanceInput,
  ): Promise<SandboxRuntimeInstance> => {
    const [runtimeInstance] = await db
      .insert(sandboxRuntimeInstances)
      .values({
        runId: input.runId,
        status: input.status,
        ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
        ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
        ...(input.launchedAt === undefined ? {} : { launchedAt: input.launchedAt }),
        ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
      } satisfies NewSandboxRuntimeInstance)
      .onConflictDoUpdate({
        target: sandboxRuntimeInstances.runId,
        set: {
          status: input.status,
          ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
          ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
          ...(input.reference === undefined ? {} : { reference: input.reference }),
          ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
          ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
          ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
          ...(input.launchedAt === undefined ? {} : { launchedAt: input.launchedAt }),
          ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
        },
      })
      .returning();

    if (runtimeInstance === undefined) {
      throw new Error(`Failed to upsert runtime instance for run ${input.runId}.`);
    }

    return runtimeInstance;
  };

  const getRuntimeInstanceByRunId = async (
    runId: string,
  ): Promise<SandboxRuntimeInstance | undefined> => {
    const [runtimeInstance] = await db
      .select()
      .from(sandboxRuntimeInstances)
      .where(eq(sandboxRuntimeInstances.runId, runId))
      .limit(1);

    return runtimeInstance;
  };

  const listRuntimeInstancesByRunIds = async (
    runIds: readonly string[],
  ): Promise<ReadonlyMap<string, SandboxRuntimeInstance>> => {
    if (runIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select()
      .from(sandboxRuntimeInstances)
      .where(inArray(sandboxRuntimeInstances.runId, [...runIds]))
      .orderBy(desc(sandboxRuntimeInstances.updatedAt));

    return new Map(rows.map((row) => [row.runId, row]));
  };

  return {
    getRuntimeInstanceByRunId,
    listRuntimeInstancesByRunIds,
    upsertRuntimeInstance,
  };
};

export type SandboxRuntimeInstanceRepository = ReturnType<
  typeof createSandboxRuntimeInstanceRepository
>;
