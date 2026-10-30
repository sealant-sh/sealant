/**
 * Admission to a resource domain's budget, for the routes that will create a domain's objects
 * (its services and volumes). There is no route yet, so its refusals are not in the contract: the
 * first route that returns them declares them. A caller admits inside the transaction that records
 * its object, runs the runtime after the commit, and records what the runtime confirmed.
 */
import {
  RESOURCE_DOMAIN_BUDGET_DIMENSIONS,
  ResourceDomainInternalServerError,
  ResourceDomainNotFoundError,
} from "@sealant/api-contracts";
import {
  ResourceDomainRepo,
  type ResourceDomainAdmission,
  type ResourceDomainAdmissionRequest,
  type ResourceDomainAllocationEvent,
} from "@sealant/db";
import { Effect, Schema } from "effect";
import * as Rec from "effect/Record";

const Amount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));

/**
 * `used + reserved + requested > limit` in `dimension`: nothing was admitted or deleted. Room comes
 * from the `remedies`: raising the budget, or purging (storage) or stopping (CPU, memory) objects
 * the caller chooses. It quotes nothing the request sent beyond these numbers.
 */
export class ResourceDomainBudgetReachedError extends Schema.TaggedError<ResourceDomainBudgetReachedError>()(
  "ResourceDomainBudgetReachedError",
  {
    message: Schema.String,
    dimension: Schema.Literals(Rec.keys(RESOURCE_DOMAIN_BUDGET_DIMENSIONS)),
    used: Amount,
    reserved: Amount,
    requested: Amount,
    limit: Amount,
    remedies: Schema.Array(Schema.Literals(["raise-budget", "purge-objects", "stop-objects"])),
  },
) {}

type Refusal = Extract<ResourceDomainAdmission, { kind: "refused" }>["reason"];

const REFUSALS: Record<Refusal, string> = {
  "invalid-amount": "An amount is not a whole number of millicores or bytes that can be held.",
  "domain-not-active": "This resource domain is fenced or archived: it admits only preservation.",
  "operation-key-reused": "This operation key was admitted for another request.",
  "operation-released": "This operation was admitted and released since; admit a new one.",
  "object-held": "This object already holds an allocation.",
  "no-source-volume": "A backup needs a volume this resource domain holds.",
};

/** An admission that does not apply (`reason`); nothing changed. */
export class ResourceDomainAdmissionRefusedError extends Schema.TaggedError<ResourceDomainAdmissionRefusedError>()(
  "ResourceDomainAdmissionRefusedError",
  {
    message: Schema.String,
    reason: Schema.Literals(Rec.keys(REFUSALS)),
  },
) {}

/** A recorded event that does not fit its allocation: the caller's defect, never a client's. */
export class ResourceDomainAllocationEventError extends Schema.TaggedError<ResourceDomainAllocationEventError>()(
  "ResourceDomainAllocationEventError",
  {
    message: Schema.String,
    reason: Schema.Literals(["event-does-not-apply", "no-such-allocation"]),
  },
) {}

const internal = (message: string) => () => new ResourceDomainInternalServerError({ message });

/** Hold capacity for one operation. A repeat of the operation answers its allocation again. */
export const admitToResourceDomain = (input: {
  readonly resourceDomainId: string;
  readonly operationKey: string;
  readonly request: ResourceDomainAdmissionRequest;
}) =>
  Effect.gen(function* () {
    const repo = yield* ResourceDomainRepo;
    const outcome = yield* repo
      .admit(input)
      .pipe(Effect.mapError(internal("Failed to admit to the resource domain.")));
    switch (outcome.kind) {
      case "admitted":
        return { allocation: outcome.allocation, replayed: outcome.replayed };
      case "no-such-domain":
        return yield* new ResourceDomainNotFoundError({ message: "Resource domain not found." });
      case "refused":
        return yield* new ResourceDomainAdmissionRefusedError({
          reason: outcome.reason,
          message: REFUSALS[outcome.reason],
        });
      case "over-budget": {
        const { dimension, used, reserved, requested, limit } = outcome;
        const { name, freedBy } = RESOURCE_DOMAIN_BUDGET_DIMENSIONS[dimension];
        return yield* new ResourceDomainBudgetReachedError({
          message: `The resource domain's ${name} budget has no room: ${used} used and ${reserved} reserved of ${limit}, and ${requested} requested. Nothing was admitted and nothing was deleted. Raise the budget, or ${freedBy === "purge-objects" ? "purge" : "stop"} objects you choose.`,
          dimension,
          used,
          reserved,
          requested,
          limit,
          remedies: ["raise-budget", freedBy],
        });
      }
    }
  });

/**
 * Record what the runtime confirmed about an allocation's object: `created`, `archived` (a
 * volume, still charged), `stopped` (releases compute) or `purged` (releases storage). Recording
 * one again answers the same allocation.
 */
export const recordResourceDomainAllocation = (input: {
  readonly resourceDomainId: string;
  readonly allocationId: string;
  readonly event: ResourceDomainAllocationEvent;
}) =>
  Effect.gen(function* () {
    const repo = yield* ResourceDomainRepo;
    const outcome = yield* repo
      .record(input)
      .pipe(Effect.mapError(internal("Failed to record the allocation's event.")));
    switch (outcome.kind) {
      case "recorded":
        return outcome.allocation;
      case "no-such-allocation":
        return yield* new ResourceDomainAllocationEventError({
          reason: "no-such-allocation",
          message: "This resource domain holds no such allocation.",
        });
      case "refused":
        return yield* new ResourceDomainAllocationEventError({
          reason: "event-does-not-apply",
          message: "That event does not apply to this allocation's use or state; nothing changed.",
        });
    }
  });
