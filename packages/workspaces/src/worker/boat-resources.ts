import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { CredentialCipher } from "@sealant/credentials";
import {
  BoatRunRepo,
  BoatRunRepoLive,
  BoatTunnelRepo,
  BoatTunnelStoreError,
  boatTunnelRepoLayer,
  ResourceInstanceRepo,
  ResourceInstanceRepoLive,
  type ResourceWorkspaceLink,
  type SealantDB,
} from "@sealant/db";
import { boatRunLaunchPhase, boatRunVmPhase, type BoatExecutionTarget } from "@sealant/validators";
import { Context, Effect, Layer, Semaphore } from "effect";

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
/**
 * The sweep entries an operator should hear about: a run whose resources are held or unavailable.
 * A run launched without resources has nothing to configure, so it is never one of them; reporting
 * it would list every such run on every pass and bury a tunnel that really is held.
 */
export const boatResourceObligations = (
  entries: BoatResourcesSweep["entries"],
): BoatResourcesSweep["entries"] =>
  entries.filter(
    (entry) => !["configured", "closed", "pending", "no-resources"].includes(entry.outcome),
  );

/** What one visit of a run found. `no-resources`: launched without resources, nothing to configure. */
export type BoatResourcesOutcome =
  | "configured"
  | "closed"
  | "pending"
  | "held"
  | "unavailable"
  | "no-resources";
/** One bounded page; failures advance the cursor without resetting any durable intent. */
export interface BoatResourcesPage {
  readonly entries: readonly {
    readonly runId: string;
    readonly outcome: BoatResourcesOutcome;
  }[];
  readonly next?: string;
}
/** One tick: a page of every allocation and, when asked for, the page of live runs before it. */
export interface BoatResourcesSweep extends BoatResourcesPage {
  readonly live?: BoatResourcesPage;
}
/**
 * The bounds on configuring runs outside a launch. Every tick visits `livePage` live runs, so
 * with N of them each is visited every ceil(N / livePage) ticks whatever the deployment's history.
 * At most `concurrency` runs are configured at once across the sweep's two pages and link jobs,
 * each for at most `entryTimeoutMs`; link jobs take at most `linkJobs` of those turns, so a burst
 * of links leaves the sweep, which shares the worker's tick with allocation and close work, at
 * least the rest.
 */
export const BOAT_RESOURCE_PASS = {
  livePage: 20,
  concurrency: 4,
  linkJobs: 2,
  entryTimeoutMs: 120_000,
} as const;
/** What a worker's start pass did: the live runs whose carrier it ensured. */
export interface BoatCarriersReopened {
  readonly runIds: readonly string[];
}
/**
 * The start pass's bounds. Live runs are read a page at a time, carriers are opened a few at a
 * time and each waits for its first attempt to connect before the next one starts, at most
 * `settleMs`, so a restart does not send every upgrade to Boat's hosted proxy at once.
 */
export const BOAT_CARRIER_REOPEN = { page: 100, concurrency: 4, settleMs: 15_000 } as const;
/** Reconciles existing installed executions only, never allocation, staging or launch. */
export class BoatResources extends Context.Service<
  BoatResources,
  {
    readonly prepare: (
      target: BoatExecutionTarget,
    ) => Effect.Effect<BoatResourcesReceipt, BoatResourcesError>;
    /**
     * One page of every allocation the deployment ever had: a live run is configured, an ended one
     * reported closed or held and its carrier released.
     *
     * With `live`, a page of the live runs that have a tunnel on this gateway host is configured
     * first, by its own cursor, so how soon a live run's link is applied does not depend on how
     * many runs have ended. A run that page visited is not configured again by this call: the
     * page of every allocation reports the outcome it had.
     */
    readonly reconcile: (input: {
      readonly limit: number;
      readonly after?: string;
      readonly live?: { readonly limit: number; readonly after?: string };
    }) => Effect.Effect<BoatResourcesSweep, BoatResourcesError>;
    /**
     * Configure one run now, as the sweep does when its cursor reaches it: for a link written or
     * removed while the run is live. It waits for a configuration of the same run in flight, then
     * runs again, since that one may have read the link before the change. It releases nothing:
     * a run that is stopping, ended, launched without resources or not this deployment's is left
     * as it is, and so is every run on a deployment with no resource gateway.
     */
    readonly apply: (runId: string) => Effect.Effect<BoatResourcesOutcome>;
    /**
     * At worker start: ensure the carrier of every live run with a tunnel on this gateway host,
     * and nothing else. The sweep opens a carrier only as it configures the run, a page of live
     * runs a tick; this pass reads every live run at once. It configures no gateway or guest
     * and releases nothing: the sweep still owns both. Nothing to do without a gateway.
     */
    readonly reopenCarriers: () => Effect.Effect<BoatCarriersReopened, BoatResourcesError>;
    /** Used only for resource idle accounting. Generic Docker convergence must not own Boat networks. */
    readonly reach: () => Effect.Effect<readonly ResourceWorkspaceLink[], BoatResourcesError>;
  }
>()("@sealant/workspaces/boat/BoatResources") {}
/** The Docker host a deployment's resource gateways run on, and where this worker reaches it. */
export interface BoatGatewayHost {
  /** Stable operator host identity, never inferred from a container. */
  readonly hostId: string;
  readonly tunnel: BoatTunnel;
  readonly subnets: ResourceSubnets;
  /**
   * Where this worker reaches the gateways' published WireGuard ports. Core carries every
   * tunnel over the agent's `/sealant/tunnel` WebSocket and relays it here, so no VM dials the
   * gateway's host and that host needs no inbound port.
   */
  readonly relay: { readonly host: string };
}
/**
 * This deployment's Boat resource host. `gateway` is absent on a deployment with no resource
 * gateway: it serves only runs launched without resources (`resources: "none"` on the run's row),
 * configures nothing, and leaves any tunnel another deployment shape recorded in custody.
 */
export class BoatResourcesHost extends Context.Service<
  BoatResourcesHost,
  {
    readonly deploymentId: string;
    readonly gateway?: BoatGatewayHost;
  }
>()("@sealant/workspaces/boat/BoatResourcesHost") {}

/** The typed refusal of gateway work on a deployment that has no resource gateway. */
const gatewayUnavailable = () =>
  new BoatResourcesError("unavailable", {
    step: "readiness",
    errorClass: "BoatResourcesError",
    code: "gateway-unavailable",
    resourceOperation: "check-authority",
  });

/** A page's entries and, when the page was full, the cursor of the next one. */
const page = (
  ids: readonly string[],
  limit: number,
  entries: BoatResourcesPage["entries"],
): BoatResourcesPage => {
  const last = ids.at(-1);
  return { entries, ...(ids.length === limit && last !== undefined ? { next: last } : {}) };
};

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
  | BoatRunRepo
  | BoatTunnelRepo
  | ResourceInstanceRepo
  | BoatTunnelCredentialsOwner
  | BoatExecution
  | BoatResourcesHost
  | BoatTunnelCarrier
> = Effect.gen(function* () {
  const runs = yield* BoatRunRepo;
  const tunnels = yield* BoatTunnelRepo;
  const resources = yield* ResourceInstanceRepo;
  const credentials = yield* BoatTunnelCredentialsOwner;
  const guest = yield* BoatExecution;
  const host = yield* BoatResourcesHost;
  const carrier = yield* BoatTunnelCarrier;
  const isCurrent = (target: BoatExecutionTarget) =>
    boatTargetIsCurrent(target).pipe(Effect.provideService(BoatRunRepo, runs));
  const current = (target: BoatExecutionTarget) =>
    Effect.gen(function* () {
      const run = yield* runs.get(target.runId);
      if (target.deploymentId !== host.deploymentId || !isDeepStrictEqual(run?.target, target))
        return yield* Effect.fail(new BoatResourcesError("binding-conflict"));
      const phase = run === undefined ? "none" : boatRunLaunchPhase(run);
      if (!(yield* isCurrent(target)) || run === undefined || phase === "held")
        return yield* Effect.fail(new BoatResourcesError("held"));
      if (
        run.admissionOperationId === null ||
        run.admissionEpoch === null ||
        !["installed", "issued", "running"].includes(phase)
      )
        return yield* Effect.fail(new BoatResourcesError("pending"));
      return { epoch: run.admissionEpoch, operationId: run.admissionOperationId };
    });
  const prepare = Effect.fn("BoatResources.prepare")(function* (target: BoatExecutionTarget) {
    // A run launched without resources is never given a gateway, a port or a tunnel, whoever asks.
    const run = yield* boundary(runs.get(target.runId), "check-authority");
    if (run?.resources === "none") return yield* Effect.fail(new BoatResourcesError("held"));
    const gatewayHost = host.gateway;
    if (gatewayHost === undefined) return yield* Effect.fail(gatewayUnavailable());
    const admission = yield* boundary(current(target), "check-authority");
    const keys = yield* boundary(
      credentials.prepare({ target, gatewayHostId: gatewayHost.hostId }),
      "prepare-credentials",
    );
    const subnet = yield* boundary(
      Effect.tryPromise({
        try: () =>
          gatewayHost.subnets.allocate({
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
      if (!isDeepStrictEqual(yield* current(target), admission))
        return yield* Effect.fail(new BoatResourcesError("binding-conflict"));
      // The link was written or removed under this configuration. Nothing is in conflict: this
      // configuration is stale, and the link's job or the next tick makes it again. `pending`
      // and not `held`, so the sweep does not release the carrier of a session that is running.
      if (!isDeepStrictEqual(yield* resources.linkOfRun(target.runId), link))
        return yield* Effect.fail(
          new BoatResourcesError("pending", {
            step: "readiness",
            errorClass: "BoatResourcesError",
            resourceOperation: "read-resources",
          }),
        );
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
          gatewayHost.tunnel.ensure({
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
      gateway: { host: gatewayHost.relay.host, port: keys.listenPort },
    });
    return { gateway, guest: receipt };
  });
  // One run is configured by one caller at a time in this process, and `concurrency` runs at
  // once: the sweep's two pages and link jobs all take their turn here.
  const turns = yield* Semaphore.make(BOAT_RESOURCE_PASS.concurrency);
  const inTurn = new Map<string, { readonly turn: Semaphore.Semaphore; waiting: number }>();
  const exclusively = <A, E>(id: string, effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = inTurn.get(id) ?? { turn: Semaphore.makeUnsafe(1), waiting: 0 };
        entry.waiting += 1;
        inTurn.set(id, entry);
        return entry;
      }),
      (entry) => entry.turn.withPermits(1)(turns.withPermits(1)(effect)),
      (entry) =>
        Effect.sync(() => {
          entry.waiting -= 1;
          if (entry.waiting === 0) inTurn.delete(id);
        }),
    );
  /** What the run needs: an outcome that is already known, or the target to configure. */
  const candidate = (id: string) =>
    Effect.gen(function* () {
      const run = yield* runs.get(id);
      // Launched without resources: no gateway, tunnel or carrier exists for it, in any phase.
      if (run?.resources === "none") return "no-resources" as const;
      // Another deployment's run is never configured from here; a link job can name any run.
      if (run !== undefined && run.deploymentId !== host.deploymentId) return "held" as const;
      const phase = run === undefined ? undefined : boatRunVmPhase(run);
      if (phase === "deleted") {
        // Boat no longer has the guest. Never try to configure it. Host cleanup is a separate
        // obligation until the removal releases its reservation.
        const tunnel = yield* tunnels.get(id);
        return tunnel === undefined || tunnel.released === true
          ? ("closed" as const)
          : ("held" as const);
      }
      if (phase === "held") return "held" as const;
      if (run === undefined || run.target === null) return "pending" as const;
      // A live launch owns its guest and gateway until it finishes or its lease lapses.
      if (yield* runs.launchInFlight(id)) return "pending" as const;
      // No resource gateway here: a run that has a tunnel cannot be configured from this worker.
      if (host.gateway === undefined) return "unavailable" as const;
      return run.target;
    });
  /**
   * Visit one run: report what is known of it, or configure it in its turn. `prepare` reads the
   * run's authority itself (its row bound to this target, its run active, its launch
   * not held) before any host or guest effect, so a run that stopped while this waited is held.
   */
  const settle = (id: string): Effect.Effect<BoatResourcesOutcome> =>
    Effect.gen(function* () {
      const known = yield* candidate(id).pipe(Effect.timeout(BOAT_RESOURCE_PASS.entryTimeoutMs));
      if (typeof known === "string") return known;
      yield* exclusively(
        id,
        boundary(prepare(known)).pipe(Effect.timeout(BOAT_RESOURCE_PASS.entryTimeoutMs)),
      );
      return "configured" as const;
    }).pipe(
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
    );
  /** A page of the live runs with a tunnel on this gateway host, each configured. No releases. */
  const reconcileLive = (input: { readonly limit: number; readonly after?: string }) =>
    Effect.gen(function* () {
      const gatewayHost = host.gateway;
      if (gatewayHost === undefined) return page([], input.limit, []);
      const ids = yield* runs.listTunnelled({
        deploymentId: host.deploymentId,
        gatewayHostId: gatewayHost.hostId,
        limit: input.limit,
        ...(input.after === undefined ? {} : { after: input.after }),
      });
      const entries = yield* Effect.forEach(
        ids,
        (id) => settle(id).pipe(Effect.map((outcome) => ({ runId: id, outcome }))),
        { concurrency: BOAT_RESOURCE_PASS.concurrency },
      );
      return page(ids, input.limit, entries);
    });
  const reconcile = Effect.fn("BoatResources.reconcile")(function* (
    input: Parameters<BoatResources["Service"]["reconcile"]>[0],
  ) {
    const live = input.live === undefined ? undefined : yield* reconcileLive(input.live);
    const settled = new Map(live?.entries.map((entry) => [entry.runId, entry.outcome]));
    const ids = yield* runs.list({
      deploymentId: host.deploymentId,
      limit: input.limit,
      ...(input.after === undefined ? {} : { after: input.after }),
    });
    const entries = yield* Effect.forEach(
      ids,
      (id) => {
        // Visited as a live run a moment ago in this call: its outcome stands, not a second visit.
        const already = settled.get(id);
        return (already === undefined ? settle(id) : Effect.succeed(already)).pipe(
          // A run that is closed or held carries no tunnel any more.
          Effect.tap((outcome) =>
            outcome === "closed" || outcome === "held" ? carrier.release(id) : Effect.void,
          ),
          Effect.map((outcome) => ({ runId: id, outcome })),
        );
      },
      { concurrency: BOAT_RESOURCE_PASS.concurrency },
    );
    return { ...page(ids, input.limit, entries), ...(live === undefined ? {} : { live }) };
  });
  /**
   * The run's configured network custody on this gateway host while its admitted epoch is current,
   * or `undefined`: its target and the reservation whose port its gateway publishes.
   */
  const configured = (id: string, gatewayHostId: string) =>
    Effect.gen(function* () {
      const run = yield* runs.get(id);
      const target = run?.target ?? undefined;
      if (run === undefined || target === undefined) return undefined;
      const reservation = yield* tunnels.get(target.runId);
      if (reservation?.network === undefined || reservation.binding.gatewayHostId !== gatewayHostId)
        return undefined;
      if (
        run.admissionOperationId === null ||
        boatRunLaunchPhase(run) === "held" ||
        !isDeepStrictEqual(target, reservation.binding.target) ||
        run.admissionEpoch !== reservation.network.epoch ||
        run.admissionOperationId !== reservation.network.operationId ||
        !(yield* isCurrent(target))
      )
        return undefined;
      return { target, reservation };
    });
  const reopenCarriers = Effect.fn("BoatResources.reopenCarriers")(function* () {
    const runIds: string[] = [];
    const gatewayHost = host.gateway;
    if (gatewayHost === undefined) return { runIds };
    let after: string | undefined;
    do {
      const ids = yield* runs.listTunnelled({
        deploymentId: host.deploymentId,
        gatewayHostId: gatewayHost.hostId,
        limit: BOAT_CARRIER_REOPEN.page,
        ...(after === undefined ? {} : { after }),
      });
      yield* Effect.forEach(
        ids,
        (id) =>
          Effect.gen(function* () {
            const custody = yield* configured(id, gatewayHost.hostId);
            if (custody === undefined) return;
            const { target, reservation } = custody;
            // A no-op for a run already carried, one holding off after a 1012 included.
            yield* carrier.ensure({
              runId: target.runId,
              connection: guest.tunnel(target),
              gateway: { host: gatewayHost.relay.host, port: reservation.listenPort },
            });
            runIds.push(target.runId);
            yield* carrier
              .settled(target.runId)
              .pipe(Effect.timeout(BOAT_CARRIER_REOPEN.settleMs), Effect.ignore);
          }).pipe(
            // One run's unreadable record never keeps the others' carriers closed.
            Effect.catch(() => Effect.void),
          ),
        { concurrency: BOAT_CARRIER_REOPEN.concurrency, discard: true },
      );
      after = ids.length === BOAT_CARRIER_REOPEN.page ? ids.at(-1) : undefined;
    } while (after !== undefined);
    return { runIds };
  });
  const reach = Effect.fn("BoatResources.reach")(function* () {
    const links: ResourceWorkspaceLink[] = [];
    // No gateway, so no Boat run reaches a resource through this worker.
    if (host.gateway === undefined) return links;
    const gatewayHostId = host.gateway.hostId;
    let after: string | undefined;
    do {
      const ids = yield* runs.list({
        deploymentId: host.deploymentId,
        limit: 100,
        ...(after === undefined ? {} : { after }),
      });
      for (const id of ids) {
        if ((yield* configured(id, gatewayHostId)) === undefined) continue;
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
    apply: Effect.fn("BoatResources.apply")((runId: string) => settle(runId)),
    reopenCarriers: () => boundary(reopenCarriers()),
    reach: () => boundary(reach()),
  });
});
/** Open assembly for faithful infrastructure and failure controls. */
export const boatResourcesLayerNoDeps: Layer.Layer<
  BoatResources,
  never,
  | BoatRunRepo
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
      BoatRunRepoLive,
      boatTunnelRepoLayer,
      ResourceInstanceRepoLive,
      boatTunnelCredentialsLayer,
    ),
  ),
);
