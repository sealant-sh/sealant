import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { CredentialCipher } from "@sealant/credentials";
import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  BoatTunnelRepo,
  BoatTunnelStoreError,
  boatTunnelRepoLayer,
  ResourceInstanceRepo,
  ResourceInstanceRepoLive,
  type ResourceWorkspaceLink,
  type SealantDB,
} from "@sealant/db";
import type { BoatExecutionTarget } from "@sealant/validators";
import { Context, Effect, Layer } from "effect";

import {
  boatTunnelName,
  type BoatTunnel,
  type BoatTunnelEndpoint,
} from "../resources/boat-tunnel.js";
import { reachNetworkName } from "../resources/docker-resource-argv.js";
import type { ResourceSubnets } from "../resources/docker-resource-runtime.js";
import {
  BoatExecution,
  BoatExecutionError,
  type BoatGuestNetworkReceipt,
} from "../runtime/boat/execution.js";
import {
  boatLaunchDiagnostic,
  boatLaunchSummary,
  type BoatLaunchDiagnostic,
} from "../runtime/boat/launch-diagnostics.js";
import { BoatTunnelCarrier } from "../runtime/boat/tunnel-carrier.js";
import {
  BoatTunnelCredentialsOwner,
  boatTunnelCredentialsLayer,
} from "../runtime/boat/tunnel-credentials.js";
import { boatTargetIsCurrent } from "./boat-current.js";

/** Safe per-entry failures retain every reservation; they never carry transport or key data. */
export class BoatResourcesError extends Error {
  readonly _tag = "BoatResourcesError";
  constructor(
    readonly code: "pending" | "held" | "binding-conflict" | "unavailable",
    readonly diagnostic?: BoatLaunchDiagnostic,
  ) {
    super(`Boat resource reconciliation: ${code}${boatLaunchSummary(diagnostic)}`);
  }
}
/** Current configuration acknowledgement only. No execution permit or readiness is produced. */
export interface BoatResourcesReceipt {
  readonly gateway: BoatTunnelEndpoint;
  readonly guest: BoatGuestNetworkReceipt;
}
/** One bounded page; failures advance the cursor without resetting any durable intent. */
export interface BoatResourcesSweep {
  readonly entries: readonly {
    readonly runId: string;
    readonly outcome: "configured" | "closed" | "pending" | "held" | "unavailable";
  }[];
  readonly next?: string;
}
/** Reconciles existing installed executions only, never allocation, staging or launch. */
export class BoatResources extends Context.Service<
  BoatResources,
  {
    readonly prepare: (
      target: BoatExecutionTarget,
    ) => Effect.Effect<BoatResourcesReceipt, BoatResourcesError>;
    readonly reconcile: (input: {
      readonly limit: number;
      readonly after?: string;
    }) => Effect.Effect<BoatResourcesSweep, BoatResourcesError>;
    /** Used only for resource idle accounting. Generic Docker convergence must not own Boat networks. */
    readonly reach: () => Effect.Effect<readonly ResourceWorkspaceLink[], BoatResourcesError>;
  }
>()("@sealant/workspaces/boat/BoatResources") {}
/** Stable operator host identity and where this worker reaches it, never inferred from a container. */
export class BoatResourcesHost extends Context.Service<
  BoatResourcesHost,
  {
    readonly deploymentId: string;
    readonly gatewayHostId: string;
    readonly tunnel: BoatTunnel;
    readonly subnets: ResourceSubnets;
    /**
     * Where this worker reaches the gateways' published WireGuard ports. Core carries every
     * tunnel over the agent's `/sealant/tunnel` WebSocket and relays it here, so no VM dials the
     * gateway's host and that host needs no inbound port.
     */
    readonly relay: { readonly host: string };
  }
>()("@sealant/workspaces/boat/BoatResourcesHost") {}

const boundary = <A>(
  effect: Effect.Effect<A, unknown>,
  resourceOperation?: BoatLaunchDiagnostic["resourceOperation"],
): Effect.Effect<A, BoatResourcesError> =>
  effect.pipe(
    Effect.mapError((error) => {
      if (error instanceof BoatResourcesError && resourceOperation === undefined) return error;
      const code =
        error instanceof BoatResourcesError
          ? error.code
          : error instanceof BoatTunnelStoreError && error.code === "binding-conflict"
            ? "binding-conflict"
            : error instanceof BoatExecutionError && error.code === "invocation-held"
              ? "held"
              : "unavailable";
      return new BoatResourcesError(code, {
        ...boatLaunchDiagnostic(error, "readiness"),
        ...(resourceOperation === undefined ? {} : { resourceOperation }),
      });
    }),
  );
const make: Effect.Effect<
  BoatResources["Service"],
  never,
  | BoatAllocationRepo
  | BoatExecutionRepo
  | BoatTunnelRepo
  | ResourceInstanceRepo
  | BoatTunnelCredentialsOwner
  | BoatExecution
  | BoatResourcesHost
  | BoatTunnelCarrier
> = Effect.gen(function* () {
  const allocations = yield* BoatAllocationRepo;
  const executions = yield* BoatExecutionRepo;
  const tunnels = yield* BoatTunnelRepo;
  const resources = yield* ResourceInstanceRepo;
  const credentials = yield* BoatTunnelCredentialsOwner;
  const guest = yield* BoatExecution;
  const host = yield* BoatResourcesHost;
  const carrier = yield* BoatTunnelCarrier;
  const isCurrent = (target: BoatExecutionTarget) =>
    boatTargetIsCurrent(target).pipe(Effect.provideService(BoatAllocationRepo, allocations));
  const current = (target: BoatExecutionTarget) =>
    Effect.gen(function* () {
      const execution = yield* executions.get(target.runtimeInstanceId);
      if (
        target.deploymentId !== host.deploymentId ||
        !isDeepStrictEqual(execution?.target, target)
      )
        return yield* Effect.fail(new BoatResourcesError("binding-conflict"));
      if (!(yield* isCurrent(target)) || execution === undefined || execution.phase === "held")
        return yield* Effect.fail(new BoatResourcesError("held"));
      if (
        execution.admission === null ||
        !["installed", "issued", "running"].includes(execution.phase)
      )
        return yield* Effect.fail(new BoatResourcesError("pending"));
      return execution.admission;
    });
  const prepare = Effect.fn("BoatResources.prepare")(function* (target: BoatExecutionTarget) {
    const admission = yield* boundary(current(target), "check-authority");
    const keys = yield* boundary(
      credentials.prepare({ target, gatewayHostId: host.gatewayHostId }),
      "prepare-credentials",
    );
    const subnet = yield* boundary(
      Effect.tryPromise({
        try: () =>
          host.subnets.allocate({
            name: reachNetworkName(boatTunnelName(target)),
            kind: "reach",
            owner: boatTunnelName(target),
          }),
        catch: (error) => error,
      }),
      "allocate-subnet",
    );
    const reservation = yield* tunnels.get(target.runtimeInstanceId);
    if (reservation === undefined)
      return yield* Effect.fail(new BoatResourcesError("binding-conflict"));
    yield* boundary(
      tunnels.configure(reservation, {
        epoch: admission.epoch,
        operationId: admission.operationId,
        subnet,
      }),
      "persist-network",
    );
    const link = yield* boundary(resources.linkOfRun(target.runId), "read-resources");
    // Match Docker's desired attachments. A person's Stop never blocks their session or gives
    // the gateway a stopped container/alias, and its observed status remains available to clients.
    const instances =
      link === undefined
        ? []
        : (yield* boundary(
            resources.list(link.resourceDomainId, { archived: false }),
            "read-resources",
          )).filter((instance) => instance.desired === "running");
    const recheck = Effect.gen(function* () {
      if (
        !isDeepStrictEqual(yield* current(target), admission) ||
        !isDeepStrictEqual(yield* resources.linkOfRun(target.runId), link)
      )
        return yield* Effect.fail(new BoatResourcesError("binding-conflict"));
    });
    yield* recheck;
    // Only a configured reservation can dispatch a gateway mutation. Allocation failures have
    // no host effect to await, and a close racing this CAS prevents the dispatch entirely.
    const gateway = yield* tunnels.withHostLock(
      keys.binding,
      Effect.gen(function* () {
        // Read authority again inside the host lock. A close may have won while we waited.
        yield* recheck;
        const updateId = randomUUID();
        const owned = yield* tunnels.get(target.runtimeInstanceId);
        if (owned === undefined || (yield* tunnels.beginUpdate(owned, updateId)) !== "issued")
          return yield* Effect.fail(new BoatResourcesError("held"));
        const endpoint = yield* boundary(
          host.tunnel.ensure({
            target,
            privateKey: keys.gateway.privateKey,
            peerKey: keys.guest.publicKey,
            listenPort: keys.listenPort,
            link,
            instances,
          }),
          "configure-gateway",
        );
        // Unknown outcomes remain in the ledger. FINAL can settle them only after fencing
        // dispatch under this same lock and removing the exact owned endpoint and networks.
        yield* boundary(tunnels.endUpdate(owned.binding, updateId), "settle-gateway");
        return endpoint;
      }),
    );
    if (
      gateway.reachSubnet !== subnet ||
      gateway.publicKey !== keys.gateway.publicKey ||
      gateway.peerKey !== keys.guest.publicKey ||
      gateway.listenPort !== keys.listenPort
    )
      return yield* Effect.fail(new BoatResourcesError("binding-conflict"));
    yield* recheck;
    const receipt = yield* boundary(
      guest.isolate(target, {
        network: { epoch: admission.epoch, operationId: admission.operationId, subnet },
        privateKey: keys.guest.privateKey,
        publicKey: keys.guest.publicKey,
        gatewayKey: keys.gateway.publicKey,
      }),
      "isolate-guest",
    );
    yield* recheck;
    // This worker holds the tunnel's WebSocket and relays it to the gateway's port here. Every
    // reconcile pass ensures it again, so a restarted worker or a dropped carrier reopens.
    yield* carrier.ensure({
      runId: target.runId,
      connection: guest.tunnel(target),
      gateway: { host: host.relay.host, port: keys.listenPort },
    });
    return { gateway, guest: receipt };
  });
  const reconcile = Effect.fn("BoatResources.reconcile")(function* (
    input: Parameters<BoatResources["Service"]["reconcile"]>[0],
  ) {
    const ids = yield* allocations.list({ deploymentId: host.deploymentId, ...input });
    const entries = yield* Effect.forEach(
      ids,
      (id) =>
        Effect.gen(function* () {
          const record = yield* allocations.get(id);
          if (record?.phase === "deleted") {
            // Deletion retains its immutable target. Never try to configure that retired guest.
            // Host cleanup is a separate obligation until canonical FINAL releases its reservation.
            const tunnel = yield* tunnels.get(record.target?.runtimeInstanceId ?? id);
            return tunnel === undefined || tunnel.released === true
              ? ("closed" as const)
              : ("held" as const);
          }
          if (record?.phase === "held") return "held" as const;
          if (record?.target === null || record === undefined) return "pending" as const;
          // A live launch owns its guest and gateway until it finishes or its lease lapses.
          if (yield* allocations.launchInFlight(id)) return "pending" as const;
          yield* boundary(prepare(record.target));
          return "configured" as const;
        }).pipe(
          Effect.timeout(120_000),
          Effect.catch((error) =>
            Effect.succeed(
              error instanceof BoatResourcesError
                ? error.code === "pending"
                  ? ("pending" as const)
                  : error.code === "held" || error.code === "binding-conflict"
                    ? ("held" as const)
                    : ("unavailable" as const)
                : ("unavailable" as const),
            ),
          ),
          // A run that is closed or held carries no tunnel any more.
          Effect.tap((outcome) =>
            outcome === "closed" || outcome === "held" ? carrier.release(id) : Effect.void,
          ),
          Effect.map((outcome) => ({ runId: id, outcome })),
        ),
      { concurrency: 4 },
    );
    const last = ids.at(-1);
    return { entries, ...(ids.length === input.limit && last !== undefined ? { next: last } : {}) };
  });
  const reach = Effect.fn("BoatResources.reach")(function* () {
    const links: ResourceWorkspaceLink[] = [];
    let after: string | undefined;
    do {
      const ids = yield* allocations.list({
        deploymentId: host.deploymentId,
        limit: 100,
        ...(after === undefined ? {} : { after }),
      });
      for (const id of ids) {
        const target = (yield* allocations.get(id))?.target ?? undefined;
        if (target === undefined) continue;
        const reservation = yield* tunnels.get(target.runtimeInstanceId);
        if (
          reservation?.network === undefined ||
          reservation.binding.gatewayHostId !== host.gatewayHostId
        )
          continue;
        const execution = yield* executions.get(target.runtimeInstanceId);
        if (
          execution?.admission === null ||
          execution === undefined ||
          execution.phase === "held" ||
          !isDeepStrictEqual(execution.target, reservation.binding.target) ||
          execution.admission.epoch !== reservation.network.epoch ||
          execution.admission.operationId !== reservation.network.operationId ||
          !(yield* isCurrent(target))
        )
          continue;
        const link = yield* resources.linkOfRun(id);
        if (link !== undefined) links.push(link);
      }
      after = ids.length === 100 ? ids.at(-1) : undefined;
    } while (after !== undefined);
    return links;
  });
  return BoatResources.of({
    prepare: (target) => boundary(prepare(target)),
    reconcile: (input) => boundary(reconcile(input)),
    reach: () => boundary(reach()),
  });
});
/** Open assembly for faithful infrastructure and failure controls. */
export const boatResourcesLayerNoDeps: Layer.Layer<
  BoatResources,
  never,
  | BoatAllocationRepo
  | BoatExecutionRepo
  | BoatTunnelRepo
  | ResourceInstanceRepo
  | BoatTunnelCredentialsOwner
  | BoatExecution
  | BoatResourcesHost
  | BoatTunnelCarrier
> = Layer.effect(BoatResources, make);
/** Owns its stores and sealed tunnel credentials. The worker supplies authenticated exchange and host I/O. */
export const boatResourcesLayer: Layer.Layer<
  BoatResources,
  never,
  SealantDB | CredentialCipher | BoatExecution | BoatResourcesHost | BoatTunnelCarrier
> = boatResourcesLayerNoDeps.pipe(
  Layer.provide(
    Layer.mergeAll(
      BoatAllocationRepoLive,
      BoatExecutionRepoLive,
      boatTunnelRepoLayer,
      ResourceInstanceRepoLive,
      boatTunnelCredentialsLayer,
    ),
  ),
);
