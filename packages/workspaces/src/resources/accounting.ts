import { randomUUID } from "node:crypto";

import { ResourceInstanceBudgetError } from "@sealant/api-contracts";
import type {
  ResourceDomainRepoService,
  ResourceInstanceRepoService,
  ResourceInstanceRecord,
  ResourceInstanceAllocation,
  ResourceDomainRepoError,
  ResourceInstanceRepoError,
} from "@sealant/db";
import { Effect } from "effect";

type AccountingError =
  | ResourceInstanceBudgetError
  | ResourceDomainRepoError
  | ResourceInstanceRepoError;

/** Admission and confirmed provider outcomes share one ledger policy across API and worker. */
export interface ResourceAccounting {
  readonly admit: (
    instance: ResourceInstanceRecord,
  ) => Effect.Effect<ResourceInstanceRecord, AccountingError>;
  readonly created: (instance: ResourceInstanceRecord) => Effect.Effect<void, AccountingError>;
  readonly stopped: (
    instance: ResourceInstanceRecord,
    archive?: boolean,
  ) => Effect.Effect<void, AccountingError>;
}

/** Caller-instance budget policy shared by API operations and crash reconciliation. */
export const makeResourceAccounting = (
  repo: ResourceInstanceRepoService,
  budgets: ResourceDomainRepoService,
): ResourceAccounting => {
  const save = (
    instance: ResourceInstanceRecord,
    allocations: ReadonlyArray<ResourceInstanceAllocation>,
  ) => repo.recordObserved(instance.id, instance.observed, { allocations });
  const record = (
    instance: ResourceInstanceRecord,
    allocation: ResourceInstanceAllocation,
    event: "created" | "stopped" | "archived",
  ) =>
    Effect.gen(function* () {
      let outcome = yield* budgets.record({
        resourceDomainId: instance.resourceDomainId,
        allocationId: allocation.id,
        event,
      });
      // A failed first start still owns its storage reservation. Confirm it before archiving,
      // even when the provider did not get far enough to confirm the whole workload.
      if (
        event === "archived" &&
        outcome.kind === "refused" &&
        outcome.allocation.state === "reserved"
      ) {
        const confirmed = yield* budgets.record({
          resourceDomainId: instance.resourceDomainId,
          allocationId: allocation.id,
          event: "created",
        });
        if (confirmed.kind === "recorded")
          outcome = yield* budgets.record({
            resourceDomainId: instance.resourceDomainId,
            allocationId: allocation.id,
            event,
          });
      }
      if (outcome.kind !== "recorded")
        return yield* new ResourceInstanceBudgetError({
          message: "The instance allocation could not be confirmed.",
        });
    });
  const admit = (instance: ResourceInstanceRecord) =>
    repo.transaction(
      Effect.gen(function* () {
        if (instance.spec.reach?.kind !== "caller") return instance;
        const allocations = [...(instance.allocations ?? [])];
        const reserve = (
          request: Parameters<ResourceDomainRepoService["admit"]>[0]["request"],
          name: string,
        ) =>
          Effect.gen(function* () {
            const outcome = yield* budgets.admit({
              resourceDomainId: instance.resourceDomainId,
              operationKey: `caller:${instance.id}:${randomUUID()}`,
              request,
            });
            if (outcome.kind !== "admitted")
              return yield* new ResourceInstanceBudgetError({
                message:
                  outcome.kind === "over-budget"
                    ? `The scope's ${outcome.dimension} budget refuses this instance. Raise its budget or stop existing compute.`
                    : "The scope refuses this instance allocation.",
              });
            allocations.push({
              id: outcome.allocation.id,
              use: request.use === "compute" ? "compute" : "volume",
              name,
              cpuMillicores: outcome.allocation.cpuMillicores,
              memoryBytes: outcome.allocation.memoryBytes,
              storageBytes: outcome.allocation.storageBytes,
            });
          });
        const limits = instance.spec.limits;
        if (
          !allocations.some(
            (allocation) =>
              allocation.use === "compute" &&
              allocation.cpuMillicores >= limits.cpuMillicores &&
              allocation.memoryBytes >= limits.memoryBytes,
          )
        ) {
          yield* reserve(
            { use: "compute", objectKey: `${instance.id}:compute:${randomUUID()}`, ...limits },
            "compute",
          );
        }
        for (const volume of instance.spec.volumes) {
          if (
            !allocations.some(
              (allocation) => allocation.use === "volume" && allocation.name === volume.name,
            )
          ) {
            if (volume.storageBytes === undefined)
              return yield* new ResourceInstanceBudgetError({
                message: "Caller volumes require storageBytes.",
              });
            yield* reserve(
              {
                use: "volume",
                objectKey: `${instance.id}:volume:${volume.name}`,
                storageBytes: volume.storageBytes,
                protectionBytes: 0,
              },
              volume.name,
            );
          }
        }
        yield* save(instance, allocations);
        return { ...instance, allocations };
      }),
    );
  const created = (instance: ResourceInstanceRecord) =>
    repo.transaction(
      Effect.gen(function* () {
        if (instance.spec.reach?.kind !== "caller") return;
        const allocations = [...(instance.allocations ?? [])];
        const compute = allocations.findLast(
          (allocation) =>
            allocation.use === "compute" &&
            allocation.cpuMillicores >= instance.spec.limits.cpuMillicores &&
            allocation.memoryBytes >= instance.spec.limits.memoryBytes,
        );
        const kept = allocations.filter(
          (allocation) => allocation.use !== "compute" || allocation === compute,
        );
        for (const allocation of allocations)
          yield* record(instance, allocation, kept.includes(allocation) ? "created" : "stopped");
        yield* save(instance, kept);
      }),
    );
  const stopped = (instance: ResourceInstanceRecord, archive = false) =>
    repo.transaction(
      Effect.gen(function* () {
        if (instance.spec.reach?.kind !== "caller") return;
        const allocations = [...(instance.allocations ?? [])];
        for (const allocation of allocations) {
          if (allocation.use === "compute") yield* record(instance, allocation, "stopped");
          else if (archive) yield* record(instance, allocation, "archived");
        }
        yield* save(
          instance,
          allocations.filter((allocation) => allocation.use !== "compute"),
        );
      }),
    );
  return { admit, created, stopped };
};
