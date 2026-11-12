import { access } from "node:fs/promises";
import { join } from "node:path";

import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
  BoatRunRepo,
  BoatRunRepoLive,
  NativePublicationRepo,
  NativePublicationRepoLive,
  SealantDB,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
  type ResourceWorkspaceLink,
} from "@sealant/db";
import type { WorkerEnv } from "@sealant/validators/env";
import {
  BoatAccountDirectory,
  BoatAccountRouterAdapter,
  BoatAllocationProvider,
  BoatControlMaterial,
  BoatConvergence,
  BoatNativeCatalog,
  BoatRemovalProvider,
  BoatResources,
  BoatResourcesHost,
  BoatRuntimeAdapter,
  BoatSnapshotBuilder,
  BoatTunnelCarrier,
  BoatVm,
  DockerBoatTunnel,
  boatAccountCatalog,
  boatAccountControl,
  boatControlMaterialLayer,
  boatConvergenceWorkerLayer,
  boatNativeCatalogLayer,
  boatProviderFromEnv,
  boatReadinessWorkerLayer,
  boatRemovalWorkerLayer,
  boatResourcesLayer,
  boatSealedExecutionLayer,
  boatVmWorkerLayer,
  loadPackagedRuntime,
  makeBoatTunnelCarrierLayer,
  verifyBoatBearers,
  type BoatAccountId,
  type BoatAccountProvider,
  type BoatAccountStack,
  type BoatAccountStacks,
  type BoatAdapterServices,
  type BoatApi,
  type BoatClientFactory,
  type BoatConvergenceSweep,
  type BoatGatewayHost,
  type BoatNativeCatalogOptions,
  type BoatNativeCatalogService,
  type BoatResourcesOutcome,
  type BoatResourcesSweep,
  type BoatSharedStop,
  type BoatVmSweep,
  type NativeCatalogSweep,
  type ResourceRuntime,
  type ResourceSubnets,
} from "@sealant/workspaces";
import { Effect, Layer, ManagedRuntime, Result } from "effect";

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

/** How the worker makes the builder of one account's images. */
export type BoatSnapshotBuilderFactory = (options: {
  readonly api: BoatApi;
  readonly journalDirectory: string;
  readonly owner: string;
}) => Promise<BoatNativeCatalogOptions["builder"]>;

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

/** The production builder: the packaged sealantd runtime, verified against its exact pin, once. */
const packagedSnapshotBuilder = (): BoatSnapshotBuilderFactory => {
  let bundle: ReturnType<typeof loadPackagedRuntime> | undefined;
  return async (options) => {
    bundle ??= loadPackagedRuntime();
    const loaded = await bundle;
    if (!loaded.ok) throw loaded.error;
    return new BoatSnapshotBuilder({ ...options, runtimeBundle: loaded.value });
  };
};

/** One account's Boat owners on this worker, and the cursors of its sweeps. */
export interface BoatWorkerStack extends BoatAccountStack {
  /** One page of the VM sweep: the creates its runs left unresolved. */
  readonly reconcileAllocations: (page: {
    readonly limit: number;
    readonly after?: string;
  }) => Promise<BoatVmSweep>;
  /**
   * One page of Boat's own convergence: the no-VM cases, the cleanup of what a VM Boat no longer
   * has still holds, and the nudge. `stop` is the worker's shared stop, which decides.
   */
  readonly reconcileConvergence:
    | ((page: {
        readonly limit: number;
        readonly after?: string;
        readonly stop: BoatSharedStop;
      }) => Promise<BoatConvergenceSweep>)
    | undefined;
  /** One tick of the resource sweep; with `live`, a page of live runs is configured first. */
  readonly reconcileResources:
    | ((page: {
        readonly limit: number;
        readonly after?: string;
        readonly live?: { readonly limit: number; readonly after?: string };
      }) => Promise<BoatResourcesSweep>)
    | undefined;
  /** One page of the account's build journals; nothing for an account that never built here. */
  readonly reconcileCatalog: (() => Promise<NativeCatalogSweep | undefined>) | undefined;
  /** Where each of the sweeps above stopped last; the next tick starts there. */
  readonly cursors: {
    vm?: string | undefined;
    convergence?: string | undefined;
    resource?: string | undefined;
    liveResource?: string | undefined;
    catalog?: string | undefined;
  };
}

interface Stack extends BoatWorkerStack {
  readonly reach: (() => Promise<readonly ResourceWorkspaceLink[]>) | undefined;
  readonly reopenCarriers: (() => Promise<{ readonly runIds: readonly string[] }>) | undefined;
  readonly verifyBearers:
    | (() => Promise<{ readonly checked: number; readonly unopened: readonly string[] }>)
    | undefined;
  readonly applyLink: ((runId: string) => Promise<BoatResourcesOutcome>) | undefined;
  readonly dispose: () => Promise<void>;
}

/**
 * What this worker runs for Boat, from its settings alone, or `undefined` when it has no Boat key.
 *
 * Every Boat account of the install (the default one, from the env key, and each stored one) gets
 * its own copy of the Boat owners below, built on that account's client and deployment label: a
 * run is created under one account and every later call for it uses that account's key. A stored
 * account's copy is built when something first needs it (its first launch, a sweep of its runs),
 * never at worker start for an account that has none.
 *
 * - With the builder (`SEALANT_BOAT_BUILDER_OWNER` and `SEALANT_BOAT_STATE_DIRECTORY`) it serves
 *   Boat workspaces: the adapter is registered, and its stops go through the shared stop path as
 *   every runtime's do, with a resource gateway or without one. The resource gateway is optional.
 *   With it, Boat workspaces of every account reach project resources through gateways on this
 *   worker's Docker host: the tunnel is carried over the VM's hosted HTTPS route, which each
 *   account's own key opens. Without it, Boat needs no Docker host: the worker serves workspaces
 *   created never to be linked to resources (`runtime.resources: "none"`) and refuses any other
 *   Boat workspace before its build (`gateway-unavailable`).
 * - With the gateway and no builder it launches nothing and owns Boat's sweeps for its gateway.
 * - With the Boat key alone it resolves its runs' creates (the VM sweep) and nothing else.
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
  readonly snapshotBuilder?: BoatSnapshotBuilderFactory;
  /** How a Boat key is opened into a client. Absent: Boat's real API; a test supplies a fake. */
  readonly clientFor?: BoatClientFactory;
  /** How often a stored account's key revision is read again. Default 10 s. */
  readonly revisionCheckMs?: number;
}) => {
  const { env, db, credentialCipher } = input;
  const defaultProvider = boatProviderFromEnv(env, input.clientFor);
  if (defaultProvider === undefined) return undefined;
  if (credentialCipher === undefined)
    throw new Error("Boat reconciliation configuration is incomplete.");
  const gateway = boatGatewayHost(env, input.docker);
  // Boat serves launches where its builder is configured, the way MicroVM does where its build
  // role is: the worker's env schema then holds the Boat provider configuration complete.
  const launches = env.SEALANT_BOAT_BUILDER_OWNER !== undefined;
  const stateDirectory = env.SEALANT_BOAT_STATE_DIRECTORY;
  if (launches && stateDirectory === undefined)
    throw new Error("Boat construction custody is not configured.");
  const allocationsOnly = gateway === undefined && !launches;
  const directory = new BoatAccountDirectory({
    db,
    cipher: credentialCipher,
    defaultAccount: { ...defaultProvider, builderOwner: env.SEALANT_BOAT_BUILDER_OWNER },
    ...(input.clientFor === undefined ? {} : { clientFor: input.clientFor }),
    ...(input.revisionCheckMs === undefined ? {} : { revisionCheckMs: input.revisionCheckMs }),
  });
  const Infra = Layer.mergeAll(
    Layer.succeed(SealantDB, db),
    Layer.succeed(CredentialCipher, credentialCipher),
  );
  /** The repositories the routing reads: which account a run, a VM or an image belongs to. */
  const repos = ManagedRuntime.make(
    Layer.mergeAll(BoatRunRepoLive, NativePublicationRepoLive).pipe(Layer.provide(Infra)),
  );
  // One carrier per run in this process, shared by every account's Boat owners. It opens nothing
  // until a run with a tunnel asks; a deployment with no gateway never asks.
  const carriers = allocationsOnly
    ? undefined
    : ManagedRuntime.make(makeBoatTunnelCarrierLayer({ log: (message) => console.log(message) }));
  const carrier = await carriers?.runPromise(BoatTunnelCarrier);
  const makeBuilder = input.snapshotBuilder ?? packagedSnapshotBuilder();

  /** Where an account's build journals live: the default account's where they always were. */
  const journalDirectory = (accountId: BoatAccountId) =>
    stateDirectory === undefined
      ? undefined
      : accountId === null
        ? join(stateDirectory, "native-builds")
        : join(stateDirectory, "boat-accounts", accountId, "native-builds");

  const build = async (provider: BoatAccountProvider): Promise<Stack> => {
    const { accountId, deploymentId, api } = provider;
    const Provider = Layer.succeed(BoatAllocationProvider, {
      deploymentId,
      ...(accountId === null ? {} : { accountId }),
      api,
    });
    const Base = Layer.merge(Infra, Provider);
    const cursors: Stack["cursors"] = {};
    if (allocationsOnly || carrier === undefined) {
      const runtime = ManagedRuntime.make(boatVmWorkerLayer.pipe(Layer.provide(Base)));
      return {
        accountId,
        deploymentId,
        adapter: undefined,
        control: undefined,
        catalog: async () => undefined,
        reconcileAllocations: (page) =>
          runtime.runPromise(Effect.flatMap(BoatVm, (vms) => vms.reconcile(page))),
        reconcileConvergence: undefined,
        reconcileResources: undefined,
        reconcileCatalog: undefined,
        reach: undefined,
        reopenCarriers: undefined,
        verifyBearers: undefined,
        applyLink: undefined,
        cursors,
        dispose: () => runtime.dispose(),
      };
    }
    const Host = Layer.succeed(BoatResourcesHost, {
      deploymentId,
      ...(gateway === undefined ? {} : { gateway }),
    });
    const Resources = boatResourcesLayer.pipe(Layer.provide(boatSealedExecutionLayer));
    const Repos = Layer.mergeAll(
      BoatRunRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
      WorkspaceCaptureDrainRepoLive,
    ).pipe(Layer.provide(Infra));
    const WorkerLayer: Layer.Layer<
      BoatAdapterServices | BoatResources | BoatControlMaterial | BoatConvergence | CredentialCipher
    > = Layer.mergeAll(
      boatVmWorkerLayer,
      Resources,
      boatReadinessWorkerLayer,
      // What stays Boat's own: the no-VM cases, the cleanup after absence, the nudge.
      boatConvergenceWorkerLayer,
      // The adapter's `stop`: the one deletion. Presence is read by the VM owner above.
      boatRemovalWorkerLayer,
      boatSealedExecutionLayer,
      boatControlMaterialLayer,
    ).pipe(
      Layer.provideMerge(Repos),
      Layer.provideMerge(
        Layer.mergeAll(
          Base,
          Host,
          Layer.succeed(BoatTunnelCarrier, carrier),
          Layer.succeed(BoatRemovalProvider, { api }),
        ),
      ),
    );
    const runtime = ManagedRuntime.make(WorkerLayer);
    // One adapter per account: every stop, inspection and recovery of a Boat run goes through
    // the shared paths with its account's, on a worker that launches Boat workspaces and on one
    // that only holds their gateway (whose tunnels no other worker can release).
    const adapter = new BoatRuntimeAdapter({
      deploymentId,
      ...(accountId === null ? {} : { accountId }),
      runtime,
      resourceGateway: gateway !== undefined,
    });
    const control = await runtime.runPromise(BoatControlMaterial);
    // The account's image catalog and builder, made on first use: a stored account builds its
    // images in its own Boat account on its first launch, and never before.
    const journals = journalDirectory(accountId);
    let catalogRuntime: ManagedRuntime.ManagedRuntime<BoatNativeCatalog, never> | undefined;
    let catalog: Promise<BoatNativeCatalogService | undefined> | undefined;
    const catalogOf = () => {
      catalog ??= (async () => {
        const owner = provider.builderOwner;
        if (!launches || journals === undefined || owner === undefined) return undefined;
        const builder = await makeBuilder({ api, journalDirectory: journals, owner });
        catalogRuntime = ManagedRuntime.make(
          boatNativeCatalogLayer({ deploymentId, builder }).pipe(Layer.provide(Infra)),
        );
        return catalogRuntime.runPromise(BoatNativeCatalog);
      })();
      catalog.catch(() => {
        // A failed construction is tried again by the next caller.
        catalog = undefined;
      });
      return catalog;
    };
    /** Whether this account ever built here: its journals exist. */
    const hasJournals = async () =>
      journals !== undefined &&
      (await access(journals).then(
        () => true,
        () => false,
      ));
    return {
      accountId,
      deploymentId,
      adapter,
      control,
      catalog: catalogOf,
      reconcileAllocations: (page) =>
        runtime.runPromise(Effect.flatMap(BoatVm, (vms) => vms.reconcile(page))),
      reconcileConvergence: (page) =>
        runtime.runPromise(
          Effect.flatMap(BoatConvergence, (convergence) => convergence.reconcile(page)),
        ),
      reconcileResources: (page) =>
        runtime.runPromise(Effect.flatMap(BoatResources, (resources) => resources.reconcile(page))),
      reconcileCatalog: !launches
        ? undefined
        : async () => {
            // The default account's journals are always read; a stored account's only once it
            // has built here (or its catalog is already in use).
            if (accountId !== null && catalog === undefined && !(await hasJournals()))
              return undefined;
            const service = await catalogOf();
            if (service === undefined) return undefined;
            const report = await Effect.runPromise(
              service.reconcile({
                limit: 20,
                ...(cursors.catalog === undefined ? {} : { after: cursors.catalog }),
              }),
            );
            cursors.catalog = report.next;
            return report;
          },
      reach:
        gateway === undefined
          ? undefined
          : () =>
              runtime.runPromise(Effect.flatMap(BoatResources, (resources) => resources.reach())),
      reopenCarriers:
        gateway === undefined
          ? undefined
          : () =>
              runtime.runPromise(
                Effect.flatMap(BoatResources, (resources) => resources.reopenCarriers()),
              ),
      verifyBearers: () => runtime.runPromise(verifyBoatBearers(deploymentId)),
      applyLink: (runId) =>
        runtime.runPromise(Effect.flatMap(BoatResources, (resources) => resources.apply(runId))),
      cursors,
      dispose: async () => {
        await runtime.dispose();
        await catalogRuntime?.dispose();
      },
    };
  };

  // The default account's owners are built at start, as they always were.
  const fallback = await build({
    accountId: null,
    deploymentId: defaultProvider.deploymentId,
    builderOwner: env.SEALANT_BOAT_BUILDER_OWNER,
    api: defaultProvider.api,
  });
  const stored = new Map<string, Promise<Stack | undefined>>();
  /** The stacks of accounts removed while this worker ran: disposed at shutdown. */
  const retired: Stack[] = [];
  /** The stack of an account, built once per process; `undefined` for one unknown or removed. */
  const stackOf = (accountId: BoatAccountId): Promise<Stack | undefined> => {
    if (accountId === null) return Promise.resolve(fallback);
    let stack = stored.get(accountId);
    if (stack === undefined) {
      stack = directory
        .provider(accountId)
        .then((provider) => (provider === undefined ? undefined : build(provider)));
      stored.set(accountId, stack);
      const pending = stack;
      // Nothing known of it yet (an unknown id, a store that failed): asked again next time.
      void (async () => {
        if (
          (await pending.catch(() => undefined)) === undefined &&
          stored.get(accountId) === pending
        )
          stored.delete(accountId);
      })();
    }
    return stack;
  };
  const runRepo = <A, E>(effect: Effect.Effect<A, E, BoatRunRepo | NativePublicationRepo>) =>
    repos.runPromise(effect);
  /** The stack of the account a run was created under. */
  const ofRun = async (runId: string) => {
    const run = await runRepo(Effect.flatMap(BoatRunRepo, (runs) => runs.get(runId)));
    return run === undefined ? undefined : stackOf(run.accountId);
  };
  const stacks: BoatAccountStacks = {
    fallback,
    launching: async (accountId) => {
      if (accountId === null) return fallback;
      const account = await directory.account(accountId);
      if (account === undefined || account.removalRequestedAt !== null) return undefined;
      return stackOf(accountId);
    },
    ofRun,
    ofSandbox: async (sandboxId) => {
      const found = await runRepo(
        Effect.flatMap(BoatRunRepo, (runs) => runs.locateSandbox(sandboxId)),
      );
      const [only, other] = found;
      if (only === undefined) return undefined;
      if (other !== undefined) throw new Error("Two Boat runs of this install name one VM.");
      return stackOf(only.accountId);
    },
    ofDeployment: async (deploymentId) => {
      const accountId = await directory.accountOfDeployment(deploymentId);
      return accountId === undefined ? undefined : stackOf(accountId);
    },
  };
  /** The default account, and every stored account that has runs or is being removed. */
  const sweptStacks = async (): Promise<readonly Stack[]> => {
    const accounts = [...(await directory.listWithRuns()), ...(await directory.listRemoving())];
    const ids = [...new Set(accounts.map((account) => account.id))];
    const built = await Promise.all(ids.map((id) => stackOf(id).catch(() => undefined)));
    return [fallback, ...built.filter((stack): stack is Stack => stack !== undefined)];
  };

  const router = new BoatAccountRouterAdapter({ stacks, resourceGateway: gateway !== undefined });
  const defaultCatalog = await fallback.catalog();
  const registration =
    defaultCatalog === undefined
      ? undefined
      : {
          kind: "boat-native" as const,
          adapter: router,
          artifacts: boatAccountCatalog({ stacks, pins: defaultCatalog }),
        };

  /**
   * One pass of the removals asked for: each such account's saved images are deleted from its Boat
   * account (through its catalog, which refuses any still pinned), and once it holds none and has
   * no run left to settle, its sealed key is erased. Only a worker that builds images removes them.
   */
  const reconcileRemovals = async () => {
    const report: { accountId: string; outcome: "removed" | "pending" }[] = [];
    for (const account of await directory.listRemoving()) {
      const outcome = await (async () => {
        const stack = await stackOf(account.id);
        const service = await stack?.catalog();
        if (stack === undefined || service === undefined) return "pending" as const;
        const held = await runRepo(
          Effect.flatMap(NativePublicationRepo, (catalog) =>
            catalog.heldByDeployment({ deploymentId: account.deploymentId, limit: 50 }),
          ),
        );
        let remaining = 0;
        for (const record of held) {
          if (record.state === "reserved" || record.state === "building") {
            remaining += 1;
            continue;
          }
          const withdrawn = await Effect.runPromise(
            Effect.result(service.withdraw(record.ownership)),
          );
          if (Result.isFailure(withdrawn)) remaining += 1;
        }
        const unsettled = await runRepo(
          Effect.flatMap(BoatRunRepo, (runs) =>
            runs.listUnsettled({ deploymentId: account.deploymentId, limit: 1 }),
          ),
        );
        if (remaining > 0 || held.length === 50 || unsettled.length > 0) return "pending" as const;
        if ((await directory.finishRemoval(account.id)) === "held") return "pending" as const;
        // A call that already holds the stack may still be finishing on it: it is disposed with
        // the others at shutdown, never under that call.
        stored.delete(account.id);
        retired.push(stack);
        return "removed" as const;
      })().catch(() => "pending" as const);
      report.push({ accountId: account.id, outcome });
    }
    return report;
  };

  const control = allocationsOnly
    ? undefined
    : boatAccountControl(async (runId) => (await stacks.ofRun(runId))?.control);
  return {
    registration,
    /** The adapter for the shared stop, exit and recovery paths, launching or not. */
    lifecycle: allocationsOnly ? undefined : router,
    control,
    /** The accounts Boat's sweeps visit on this tick: the default one first. */
    sweptStacks,
    /** The resource links Boat runs of every account reach through this worker's gateway. */
    reach:
      gateway === undefined
        ? undefined
        : async () => {
            const links = await Promise.all(
              (await sweptStacks()).map((stack) => stack.reach?.() ?? Promise.resolve([])),
            );
            return links.flat();
          },
    /**
     * At worker start, the carriers of the live runs with a tunnel through this worker's gateway,
     * of every account: a restart dropped every one. None to reopen without a gateway.
     */
    reopenCarriers:
      gateway === undefined
        ? undefined
        : async () => {
            const reopened = await Promise.all(
              (await sweptStacks()).map(
                (stack) => stack.reopenCarriers?.() ?? Promise.resolve({ runIds: [] }),
              ),
            );
            return { runIds: reopened.flatMap((each) => each.runIds) };
          },
    /**
     * At worker start: opens every live run's sealed bearer once and says, per run, which do not
     * open. A session whose bearer does not open cannot be drained. It never fails.
     */
    verifyBearers: allocationsOnly
      ? undefined
      : async () => {
          const results = await Promise.all(
            (await sweptStacks()).map(
              (stack) => stack.verifyBearers?.() ?? Promise.resolve({ checked: 0, unopened: [] }),
            ),
          );
          return {
            checked: results.reduce((sum, each) => sum + each.checked, 0),
            unopened: results.flatMap((each) => each.unopened),
          };
        },
    /**
     * A link was written or removed for this live run: configure it now, in its turn with the
     * sweep, with its own account's owners. A no-op for a run that needs nothing, and for every
     * run without a gateway here.
     */
    applyLink: allocationsOnly
      ? undefined
      : async (runId: string) => {
          const stack = await ofRun(runId);
          return stack?.applyLink === undefined ? ("pending" as const) : stack.applyLink(runId);
        },
    reconcileRemovals: registration === undefined ? undefined : reconcileRemovals,
    dispose: async () => {
      const built = await Promise.all(
        [...stored.values()].map((stack) => stack.catch(() => undefined)),
      );
      for (const stack of [fallback, ...built, ...retired]) await stack?.dispose();
      await carriers?.dispose();
      await repos.dispose();
    },
  };
};
