import { join } from "node:path";

import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
  BoatAllocationRepoLive,
  BoatExecutionRepoLive,
  SealantDB,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import type { WorkerEnv } from "@sealant/validators/env";
import {
  BoatAllocationProvider,
  BoatControlMaterial,
  BoatConvergence,
  BoatNativeCatalog,
  BoatRemovalProvider,
  BoatResources,
  BoatResourcesHost,
  BoatRuntimeAdapter,
  BoatSnapshotBuilder,
  DockerBoatTunnel,
  boatAllocationWorkerLayer,
  boatControlMaterialLayer,
  boatConvergenceWorkerLayer,
  boatNativeCatalogLayer,
  boatObserverLayer,
  boatProviderFromEnv,
  boatReadinessWorkerLayer,
  boatRemovalWorkerLayer,
  boatResourcesLayer,
  boatSealedExecutionLayer,
  loadPackagedRuntime,
  makeBoatTunnelCarrierLayer,
  type BoatAdapterServices,
  type BoatAllocation,
  type BoatGatewayHost,
  type BoatNativeCatalogOptions,
  type BoatSharedStop,
  type HttpBoatApi,
  type ResourceRuntime,
  type ResourceSubnets,
} from "@sealant/workspaces";
import { Effect, Layer, ManagedRuntime } from "effect";

/** The Boat settings of the worker's environment that decide what this worker does for Boat. */
export type BoatWorkerEnv = Pick<
  WorkerEnv,
  | "SEALANT_BOAT_API_KEY"
  | "SEALANT_BOAT_API_KEY_FILE"
  | "SEALANT_BOAT_DEPLOYMENT_ID"
  | "SEALANT_BOAT_BUILDER_OWNER"
  | "SEALANT_BOAT_STATE_DIRECTORY"
  | "SEALANT_BOAT_GATEWAY_HOST_ID"
  | "SEALANT_BOAT_GATEWAY_RELAY_HOST"
  | "SEALANT_BOAT_GATEWAY_IMAGE"
  | "DOCKER_SOCKET_PATH"
>;

/** The Docker resource host a resource gateway's containers and networks run on. */
export interface BoatResourceDockerHost {
  readonly subnets: ResourceSubnets | undefined;
  readonly runtime: Pick<ResourceRuntime, "attachExecutor" | "detachExecutor">;
}

/**
 * The resource gateway of this deployment, or `undefined` when it has none. The worker's env
 * schema holds its three settings all or nothing, and requires the Docker resource host with them.
 */
const boatGatewayHost = (
  env: BoatWorkerEnv,
  docker: BoatResourceDockerHost | undefined,
): BoatGatewayHost | undefined => {
  if (env.SEALANT_BOAT_GATEWAY_HOST_ID === undefined) return undefined;
  if (
    env.SEALANT_BOAT_GATEWAY_RELAY_HOST === undefined ||
    env.SEALANT_BOAT_GATEWAY_IMAGE === undefined ||
    docker === undefined ||
    docker.subnets === undefined
  )
    throw new Error("Boat resource reconciliation configuration is incomplete.");
  return {
    hostId: env.SEALANT_BOAT_GATEWAY_HOST_ID,
    relay: { host: env.SEALANT_BOAT_GATEWAY_RELAY_HOST },
    subnets: docker.subnets,
    tunnel: new DockerBoatTunnel({
      gatewayImage: env.SEALANT_BOAT_GATEWAY_IMAGE,
      subnets: docker.subnets,
      resources: docker.runtime,
      dockerSocketPath: env.DOCKER_SOCKET_PATH,
      // The port is published where the worker relays it, never on a public interface.
      publishHost: env.SEALANT_BOAT_GATEWAY_RELAY_HOST,
    }),
  };
};

/** The production builder: the packaged sealantd runtime, verified against its exact pin. */
const packagedSnapshotBuilder = async (options: {
  readonly api: HttpBoatApi;
  readonly journalDirectory: string;
  readonly owner: string;
}): Promise<BoatNativeCatalogOptions["builder"]> => {
  const bundle = await loadPackagedRuntime();
  if (!bundle.ok) throw bundle.error;
  return new BoatSnapshotBuilder({ ...options, runtimeBundle: bundle.value });
};

/**
 * What this worker runs for Boat, from its settings alone, or `undefined` when it has no Boat key.
 *
 * - With the builder (`SEALANT_BOAT_BUILDER_OWNER` and `SEALANT_BOAT_STATE_DIRECTORY`) it serves
 *   Boat workspaces: the adapter is registered, and its stops go through the shared stop path as
 *   every runtime's do, with a resource gateway or without one. The resource gateway is optional. With it, Boat workspaces reach
 *   project resources through gateways on this worker's Docker host. Without it, Boat needs no
 *   Docker host: the worker serves workspaces created never to be linked to resources
 *   (`runtime.resources: "none"`) and refuses any other Boat workspace before its build
 *   (`gateway-unavailable`).
 * - With the gateway and no builder it launches nothing and owns Boat's sweeps for its gateway.
 * - With the Boat key alone it reconciles allocations and nothing else.
 */
export const assembleBoat = async (input: {
  readonly env: BoatWorkerEnv;
  readonly db: DB;
  readonly credentialCipher: CredentialCipherService | undefined;
  /** The worker's Docker resource host, where it has one. */
  readonly docker: BoatResourceDockerHost | undefined;
  /**
   * The builder of Boat images. Absent, it is built on the packaged sealantd runtime, whose exact
   * pinned bytes only a staged release carries; a test supplies its own.
   */
  readonly snapshotBuilder?: (options: {
    readonly api: HttpBoatApi;
    readonly journalDirectory: string;
    readonly owner: string;
  }) => Promise<BoatNativeCatalogOptions["builder"]>;
}) => {
  const { env, db, credentialCipher } = input;
  const provider = boatProviderFromEnv(env);
  if (provider === undefined) return undefined;
  if (credentialCipher === undefined)
    throw new Error("Boat reconciliation configuration is incomplete.");
  const Infra = Layer.mergeAll(
    Layer.succeed(SealantDB, db),
    Layer.succeed(CredentialCipher, credentialCipher),
    Layer.succeed(BoatAllocationProvider, provider),
  );
  const gateway = boatGatewayHost(env, input.docker);
  if (gateway === undefined && env.SEALANT_BOAT_BUILDER_OWNER === undefined) {
    const WorkerLayer: Layer.Layer<BoatAllocation> = boatAllocationWorkerLayer.pipe(
      Layer.provide(Infra),
    );
    return {
      runtime: ManagedRuntime.make(WorkerLayer),
      registration: undefined,
      lifecycle: undefined,
      control: undefined,
      reach: undefined,
      reopenCarriers: undefined,
      reconcileCatalog: undefined,
      disposeCatalog: undefined,
      reconcileResources: undefined,
      applyLink: undefined,
      reconcileConvergence: undefined,
    };
  }
  const Host = Layer.succeed(BoatResourcesHost, {
    deploymentId: provider.deploymentId,
    ...(gateway === undefined ? {} : { gateway }),
  });
  const Resources = boatResourcesLayer.pipe(Layer.provide(boatSealedExecutionLayer));
  const Repos = Layer.mergeAll(
    BoatAllocationRepoLive,
    BoatExecutionRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
    WorkspaceCaptureDrainRepoLive,
  ).pipe(Layer.provide(Infra));
  // Boat serves launches where its builder is configured, the way MicroVM does where its build
  // role is: the worker's env schema then holds the Boat provider configuration complete.
  const builder = await (async () => {
    if (env.SEALANT_BOAT_BUILDER_OWNER === undefined) return undefined;
    if (env.SEALANT_BOAT_STATE_DIRECTORY === undefined)
      throw new Error("Boat construction custody is not configured.");
    return (input.snapshotBuilder ?? packagedSnapshotBuilder)({
      api: provider.api,
      journalDirectory: join(env.SEALANT_BOAT_STATE_DIRECTORY, "native-builds"),
      owner: env.SEALANT_BOAT_BUILDER_OWNER,
    });
  })();
  const catalogRuntime =
    builder === undefined
      ? undefined
      : ManagedRuntime.make(
          boatNativeCatalogLayer({ deploymentId: provider.deploymentId, builder }).pipe(
            Layer.provide(Infra),
          ),
        );
  const WorkerLayer: Layer.Layer<
    BoatAdapterServices | BoatResources | BoatControlMaterial | BoatConvergence | CredentialCipher
  > = Layer.mergeAll(
    boatAllocationWorkerLayer,
    Resources,
    boatReadinessWorkerLayer,
    // What stays Boat's own: the no-VM cases, the cleanup after absence, the nudge.
    boatConvergenceWorkerLayer,
    // The adapter's `stop` and `inspect`: the one deletion, and the one source of presence.
    boatRemovalWorkerLayer,
    boatObserverLayer,
    boatSealedExecutionLayer,
    boatControlMaterialLayer,
  ).pipe(
    Layer.provideMerge(Repos),
    Layer.provideMerge(
      Layer.mergeAll(
        Infra,
        Host,
        // One carrier per run in this process, shared by every Boat owner above. It opens nothing
        // until a run with a tunnel asks; a deployment with no gateway never asks.
        makeBoatTunnelCarrierLayer({ log: (message) => console.log(message) }),
        Layer.succeed(BoatRemovalProvider, { api: provider.api }),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(WorkerLayer);
  // One adapter: every stop, inspection and recovery of a Boat run goes through the shared paths
  // with it, on a worker that launches Boat workspaces and on one that only holds their gateway
  // (whose tunnels no other worker can release). It launches only where the builder is.
  const adapter = new BoatRuntimeAdapter({
    deploymentId: provider.deploymentId,
    runtime,
    resourceGateway: gateway !== undefined,
  });
  const registration =
    catalogRuntime === undefined
      ? undefined
      : {
          kind: "boat-native" as const,
          adapter,
          artifacts: await catalogRuntime.runPromise(BoatNativeCatalog),
        };
  let catalogCursor: string | undefined;
  const control = await runtime.runPromise(BoatControlMaterial);
  return {
    runtime,
    registration,
    /** The adapter for the shared stop, exit and recovery paths, launching or not. */
    lifecycle: adapter,
    control,
    /** The resource links Boat runs reach through this worker's gateway; none without one. */
    reach:
      gateway === undefined
        ? undefined
        : () => runtime.runPromise(Effect.flatMap(BoatResources, (resources) => resources.reach())),
    /**
     * At worker start, the carriers of the live runs with a tunnel through this worker's gateway:
     * a restart dropped every one. None to reopen without a gateway.
     */
    reopenCarriers:
      gateway === undefined
        ? undefined
        : () =>
            runtime.runPromise(
              Effect.flatMap(BoatResources, (resources) => resources.reopenCarriers()),
            ),
    reconcileCatalog:
      catalogRuntime === undefined
        ? undefined
        : async () => {
            const report = await catalogRuntime.runPromise(
              Effect.flatMap(BoatNativeCatalog, (catalog) =>
                catalog.reconcile({
                  limit: 20,
                  ...(catalogCursor === undefined ? {} : { after: catalogCursor }),
                }),
              ),
            );
            catalogCursor = report.next;
            return report;
          },
    disposeCatalog: () => catalogRuntime?.dispose(),
    /**
     * One page of Boat's own convergence: the no-VM cases, the cleanup of what a VM Boat no
     * longer has still holds, and the nudge. `stop` is the worker's shared stop, which decides.
     */
    reconcileConvergence: (page: { limit: number; after?: string; stop: BoatSharedStop }) =>
      runtime.runPromise(
        Effect.flatMap(BoatConvergence, (convergence) => convergence.reconcile(page)),
      ),
    /** One tick of the resource sweep; with `live`, a page of live runs is configured first. */
    reconcileResources: (page: {
      limit: number;
      after?: string;
      live?: { limit: number; after?: string };
    }) =>
      runtime.runPromise(Effect.flatMap(BoatResources, (resources) => resources.reconcile(page))),
    /**
     * A link was written or removed for this live run: configure it now, in its turn with the
     * sweep. A no-op for a run that needs nothing, and for every run without a gateway here.
     */
    applyLink: (runId: string) =>
      runtime.runPromise(Effect.flatMap(BoatResources, (resources) => resources.apply(runId))),
  };
};
