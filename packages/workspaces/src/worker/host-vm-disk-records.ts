/**
 * Where the host VM adapter keeps each executor's disks: the run's runtime row in Postgres
 * (`host_vm_data_disk_path`, `host_vm_base_image_digest`), which outlives the runner container a
 * `docker container prune` can take.
 */
import {
  SealantDB,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import type { HostVmDiskRecords } from "../runtime/host-vm-runtime-adapter.js";

export const databaseHostVmDiskRecords = (db: DB): HostVmDiskRecords => {
  const layer = WorkspaceRuntimeInstanceRepoLive.pipe(Layer.provide(Layer.succeed(SealantDB, db)));
  return {
    record: (input) =>
      Effect.runPromise(
        WorkspaceRuntimeInstanceRepo.use((repo) => repo.recordHostVmDisk(input)).pipe(
          Effect.provide(layer),
        ),
      ),
    load: (runId) =>
      Effect.runPromise(
        WorkspaceRuntimeInstanceRepo.use((repo) => repo.getRuntimeInstanceByRunId(runId)).pipe(
          Effect.map((row) =>
            row?.hostVmDataDiskPath == null || row.hostVmBaseImageDigest == null
              ? undefined
              : {
                  dataDiskPath: row.hostVmDataDiskPath,
                  baseImageDigest: row.hostVmBaseImageDigest,
                },
          ),
          Effect.provide(layer),
        ),
      ),
  };
};
