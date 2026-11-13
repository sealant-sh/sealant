import { access } from "node:fs/promises";
import { join } from "node:path";

import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
  BoatAccountRepo,
  BoatAccountRepoLive,
  BoatKeyProofRepo,
  BoatKeyProofRepoLive,
  BoatRunRepo,
  BoatRunRepoLive,
  NativePublicationRepo,
  NativePublicationRepoLive,
  SealantDB,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRuntimeInstanceRepoLive,
  createBoatWalletOf,
  type BoatCreateWallet,
  type BoatWalletOwner,
  type BoatWalletResolution,
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
  boatInstallNames,
  boatNativeCatalogLayer,
  boatProviderFromEnv,
  boatReadinessWorkerLayer,
  boatRemovalWorkerLayer,
  boatResourcesLayer,
  boatSandboxIdSchema,
  boatSealedExecutionLayer,
  boatSnapshotNameSchema,
  boatVmWorkerLayer,
  checkBoatKey,
  installBoatApi,
  installBuildApi,
  installWalletApi,
  loadPackagedRuntime,
  makeBoatTunnelCarrierLayer,
  openStoredBoatKey,
  refreshBoatKeyReports,
  sweepBoatKeyProofs,
  HttpBoatApi,
  verifyBoatBearers,
  type BoatAccountId,
  type BoatAccountProvider,
  type BoatAccountStack,
  type BoatAccountStacks,
  type BoatAdapterServices,
  type BoatApi,
  type BoatClientFactory,
  BoatApiError,
  type BoatConvergenceSweep,
  type BoatGatewayHost,
  type BoatKeyProofClient,
  type BoatResult,
  type BoatSecret,
  type BoatKeyRefreshOptions,
  type BoatKeyRefreshOutcome,
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
  | "SEALANT_BOAT_ORGANIZATION"
  | "SEALANT_BOAT_BUILDER_OWNER"
  | "SEALANT_BOAT_STATE_DIRECTORY"
  | "SEALANT_BOAT_GATEWAY_HOST_ID"
  | "SEALANT_BOAT_GATEWAY_RELAY_HOST"
  | "SEALANT_BOAT_GATEWAY_IMAGE"
  | "DOCKER_SOCKET_PATH"
>;

/** The bounds of one Boat image retention pass, from the worker's clock and settings. */
export interface BoatImageRetention {
  /** A stopped or failed workspace keeps the image it would start from if it stopped since. */
  readonly stoppedSince: Date;
  /** An image something used since is kept. */
  readonly unusedSince: Date;
}

/** Images a retention pass reads per page, and pages at most per account and pass. */
const RETENTION_PAGE = 50;
const RETENTION_PAGES = 20;

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

/** Runs `tasks` at most `limit` at a time. */
const pooled = async <A>(tasks: readonly (() => Promise<A>)[], limit = 8) => {
  const results: A[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const index = next++;
        const task = tasks[index];
        if (task !== undefined) results[index] = await task();
      }
    }),
  );
  return results;
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
  /**
   * One retention pass of the account's saved images (`BoatNativeCatalogService.reap`), every
   * page; nothing for an account that never built here.
   */
  readonly reapImages:
    | ((policy: BoatImageRetention) => Promise<NativeCatalogSweep["entries"] | undefined>)
    | undefined;
  /**
   * The account's catalog whose builder names `wallet` on every request (null: none), whatever the
   * account names now: what builds, verifies and removes the images recorded in that wallet.
   */
  readonly catalogIn: ((wallet: string | null) => Promise<BoatNativeCatalogService>) | undefined;
  /**
   * Reconciles one image build made before sealant recorded wallets, with a catalog of its own
   * whose builder finds the wallet the build is in (and records it), or records it unreachable.
   */
  readonly reconcileBuild: ((publicationId: string) => Promise<void>) | undefined;
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
 * What this worker runs for Boat, from its settings, or `undefined` when Boat is off for it: no
 * Boat key, no state directory and no resource gateway.
 *
 * Every Boat account of the install (the default one, from the env key, and each stored one) gets
 * its own copy of the Boat owners below, built on that account's client and deployment label: a
 * run is created under one account and every later call for it uses that account's key. A stored
 * account's copy is built when something first needs it (its first launch, a sweep of its runs),
 * never at worker start for an account that has none.
 *
 * The install's own account exists where the worker has the env key. Its names (deployment label,
 * builder owner) are the operator's settings where set, else the ones the install keeps in its
 * database (`boatInstallNames`), which the API reads too.
 *
 * - With the state directory (`SEALANT_BOAT_STATE_DIRECTORY`) it serves Boat workspaces, in the
 *   install's own account where it has the env key and in every stored account: the adapter is registered, and its stops go through the shared stop path as
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
  /** How a key is opened for its report's check. Absent: Boat's real API; a test supplies a fake. */
  readonly keyClientFor?: BoatKeyRefreshOptions["clientFor"];
  /** How a key is opened for a full check's sweep. Absent: Boat's real API; a test supplies a fake. */
  readonly proofClientFor?: (
    credential: BoatSecret,
    options?: { readonly organization?: string },
  ) => BoatResult<BoatKeyProofClient>;
}) => {
  const { env, db, credentialCipher } = input;
  const envAccount = boatProviderFromEnv(env);
  const gateway = boatGatewayHost(env, input.docker);
  // Boat serves launches where its state directory is set, the way MicroVM does where its build
  // role is: the worker's env schema then holds the cipher beside it.
  const stateDirectory = env.SEALANT_BOAT_STATE_DIRECTORY;
  const launches = stateDirectory !== undefined;
  if (envAccount === undefined && !launches && gateway === undefined) return undefined;
  if (credentialCipher === undefined)
    throw new Error("Boat reconciliation configuration is incomplete.");
  const allocationsOnly = gateway === undefined && !launches;
  const names =
    envAccount === undefined
      ? undefined
      : await boatInstallNames(
          {
            deploymentId: envAccount.deploymentId,
            builderOwner: env.SEALANT_BOAT_BUILDER_OWNER,
            withBuilder: launches,
          },
          db,
        );
  // The install's own key names the wallet `boat_install` holds for it on every request; none
  // until the resolve pass below has found it.
  const defaultProvider =
    envAccount === undefined || names === undefined
      ? undefined
      : {
          deploymentId: names.deploymentId,
          api: installBoatApi({
            db,
            credential: envAccount.credential,
            deploymentId: names.deploymentId,
            ...(input.clientFor === undefined ? {} : { clientFor: input.clientFor }),
          }),
          builderOwner: names.builderOwner,
        };
  // The install's own key, for its report's check and its full checks' sweep.
  const defaultKey =
    envAccount === undefined
      ? undefined
      : {
          credential: envAccount.credential,
          organization: envAccount.organization,
          ...(names === undefined ? {} : { deploymentId: names.deploymentId }),
        };
  const directory = new BoatAccountDirectory({
    db,
    cipher: credentialCipher,
    ...(defaultProvider === undefined ? {} : { defaultAccount: defaultProvider }),
    ...(input.clientFor === undefined ? {} : { clientFor: input.clientFor }),
    ...(input.revisionCheckMs === undefined ? {} : { revisionCheckMs: input.revisionCheckMs }),
  });
  const Infra = Layer.mergeAll(
    Layer.succeed(SealantDB, db),
    Layer.succeed(CredentialCipher, credentialCipher),
  );
  const accountRepo = <A, E>(effect: Effect.Effect<A, E, BoatAccountRepo>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(BoatAccountRepoLive), Effect.provideService(SealantDB, db)),
    );
  /** The wallet an account creates in now (the install's own key's: `null`). */
  const createWallet = async (accountId: BoatAccountId): Promise<BoatCreateWallet> => {
    if (accountId === null) {
      const stored = await accountRepo(
        Effect.flatMap(BoatAccountRepo, (repo) => repo.installWallet()),
      );
      return createBoatWalletOf(stored?.organization ?? null, stored?.keyKind ?? null);
    }
    const account = await directory.account(accountId);
    return account === undefined
      ? { kind: "unresolved" }
      : createBoatWalletOf(account.organization, account.keyKind);
  };
  /** A client for an account's key that names `wallet` on every request (null: none). */
  const walletClient = (accountId: BoatAccountId, wallet: string | null): BoatApi | undefined => {
    if (accountId !== null) return directory.walletApi(accountId, wallet);
    if (envAccount === undefined) return undefined;
    const opened = installWalletApi({
      credential: envAccount.credential,
      ...(input.clientFor === undefined ? {} : { clientFor: input.clientFor }),
      organization: wallet,
    });
    return opened.ok ? opened.value : undefined;
  };
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
        reapImages: undefined,
        catalogIn: undefined,
        reconcileBuild: undefined,
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
    // One catalog per wallet, its builder's client naming that wallet on every request: it builds,
    // verifies and removes only images recorded there. `catalogOf` is the one of the wallet the
    // account creates in now; `catalogIn` any other, for the images recorded in it.
    const catalogs = new Map<
      string,
      Promise<{
        readonly service: BoatNativeCatalogService;
        readonly runtime: ManagedRuntime.ManagedRuntime<BoatNativeCatalog, never>;
      }>
    >();
    const catalogIn = async (wallet: string | null) => {
      const owner = provider.builderOwner;
      if (!launches || journals === undefined || owner === undefined)
        throw new Error("This worker builds no images for the account.");
      const key = wallet ?? "";
      let made = catalogs.get(key);
      if (made === undefined) {
        made = (async () => {
          const walletApi = walletClient(accountId, wallet);
          if (walletApi === undefined) throw new Error("The account's key cannot be opened.");
          const builder = await makeBuilder({ api: walletApi, journalDirectory: journals, owner });
          const catalogRuntime = ManagedRuntime.make(
            boatNativeCatalogLayer({ deploymentId, builder, wallet }).pipe(Layer.provide(Infra)),
          );
          return {
            service: await catalogRuntime.runPromise(BoatNativeCatalog),
            runtime: catalogRuntime,
          };
        })();
        catalogs.set(key, made);
        made.catch(() => {
          // A failed construction is tried again by the next caller.
          if (catalogs.get(key) === made) catalogs.delete(key);
        });
      }
      return (await made).service;
    };
    const catalogOf = async () => {
      if (!launches || journals === undefined || provider.builderOwner === undefined)
        return undefined;
      const wallet = await createWallet(accountId);
      return wallet.kind === "unresolved" ? undefined : catalogIn(wallet.wallet);
    };
    const reconcileBuild = async (publicationId: string) => {
      const owner = provider.builderOwner;
      if (!launches || journals === undefined || owner === undefined) return;
      const buildApi =
        accountId !== null
          ? directory.buildApi(accountId, publicationId)
          : envAccount === undefined
            ? undefined
            : installBuildApi(
                {
                  db,
                  credential: envAccount.credential,
                  deploymentId,
                  ...(input.clientFor === undefined ? {} : { clientFor: input.clientFor }),
                },
                publicationId,
              );
      if (buildApi === undefined) return;
      const builder = await makeBuilder({ api: buildApi, journalDirectory: journals, owner });
      const catalogRuntime = ManagedRuntime.make(
        boatNativeCatalogLayer({ deploymentId, builder, wallet: { build: publicationId } }).pipe(
          Layer.provide(Infra),
        ),
      );
      try {
        const service = await catalogRuntime.runPromise(BoatNativeCatalog);
        if (service.reconcilePublication !== undefined)
          await Effect.runPromise(service.reconcilePublication(publicationId));
      } finally {
        await catalogRuntime.dispose();
      }
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
      catalogIn: launches && journals !== undefined ? catalogIn : undefined,
      reconcileBuild: launches && journals !== undefined ? reconcileBuild : undefined,
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
            if (accountId !== null && catalogs.size === 0 && !(await hasJournals()))
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
      reapImages: !launches
        ? undefined
        : async (policy) => {
            if (accountId !== null && catalogs.size === 0 && !(await hasJournals()))
              return undefined;
            const service = await catalogOf();
            if (service === undefined) return undefined;
            const entries: NativeCatalogSweep["entries"][number][] = [];
            let after: string | undefined;
            for (let page = 0; page < RETENTION_PAGES; page++) {
              const report = await Effect.runPromise(
                service.reap({
                  ...policy,
                  limit: RETENTION_PAGE,
                  ...(after === undefined ? {} : { after }),
                }),
              );
              entries.push(...report.entries);
              after = report.next;
              if (after === undefined) break;
            }
            return entries;
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
        for (const made of catalogs.values())
          await made.then((each) => each.runtime.dispose()).catch(() => undefined);
      },
    };
  };

  // The default account's owners are built at start, as they always were, where it has one.
  const fallback =
    defaultProvider === undefined
      ? undefined
      : await build({
          accountId: null,
          deploymentId: defaultProvider.deploymentId,
          builderOwner: defaultProvider.builderOwner,
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
    return [fallback, ...built].filter((stack): stack is Stack => stack !== undefined);
  };

  const router = new BoatAccountRouterAdapter({ stacks, resourceGateway: gateway !== undefined });
  // The default account's catalog is made at start, as it always was: its builder's runtime is
  // checked before the worker serves anything. Pins are the catalog repository's, any account's.

  const publications = await repos.runPromise(NativePublicationRepo);
  const registration = !launches
    ? undefined
    : {
        kind: "boat-native" as const,
        adapter: router,
        artifacts: boatAccountCatalog({
          stacks,
          pins: { markConsumer: publications.markConsumer, release: publications.release },
        }),
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
        if (stack?.catalogIn === undefined) return "pending" as const;
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
          // Removed with requests that name the wallet it was made in. One sealant has not found
          // yet waits for the resolve pass; one Boat has in no wallet is reported, not removed.
          const recorded = await runRepo(
            Effect.flatMap(NativePublicationRepo, (catalog) =>
              catalog.wallet(record.ownership.publicationId),
            ),
          );
          if (recorded?.state === "unreachable") continue;
          if (recorded?.state !== "known") {
            remaining += 1;
            continue;
          }
          const service = await stack.catalogIn(recorded.wallet);
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

  /** Every owner of Boat objects here: the install's own key, and each stored account. */
  const owners = async () => {
    const accounts = await directory.list();
    return [
      ...(fallback === undefined
        ? []
        : [
            {
              accountId: null,
              owner: { install: { deploymentId: fallback.deploymentId } } as BoatWalletOwner,
            },
          ]),
      ...accounts.map((account) => ({
        accountId: account.id as BoatAccountId,
        owner: { accountId: account.id } as BoatWalletOwner,
      })),
    ];
  };

  /**
   * One pass over the saved images recorded in a wallet other than the one their account creates
   * in now (it was pointed at another wallet since they were made): each is removed through the
   * catalog whose builder names the wallet it was made in, by the recorded removal that retention
   * uses. A launch never uses one (it builds in the account's wallet); this frees its slot.
   */
  const removeImagesElsewhere = async () => {
    const report: { accountId: string; removed: number; pending: number }[] = [];
    for (const { accountId, owner } of await owners()) {
      const outcome = await (async () => {
        // Builds not finished in a wallet the account no longer names (a change of wallet, or of
        // the install's setting, then a restart mid-build): each reconciled under its own wallet.
        const builds = await accountRepo(
          Effect.flatMap(BoatAccountRepo, (repo) => repo.buildsElsewhere(owner)),
        );
        if (builds.length > 0) {
          const stack = await stackOf(accountId);
          for (const unfinished of builds)
            await (async () => {
              const service = await stack?.catalogIn?.(unfinished.wallet);
              if (service?.reconcilePublication !== undefined)
                await Effect.runPromise(service.reconcilePublication(unfinished.publicationId));
            })().catch(() => undefined);
        }
        const elsewhere = await accountRepo(
          Effect.flatMap(BoatAccountRepo, (repo) => repo.imagesElsewhere(owner)),
        );
        if (elsewhere.length === 0) return undefined;
        const stack = await stackOf(accountId);
        if (stack?.catalogIn === undefined) return { removed: 0, pending: elsewhere.length };
        let removed = 0;
        let pending = 0;
        for (const image of elsewhere) {
          const record = await runRepo(
            Effect.flatMap(NativePublicationRepo, (catalog) => catalog.get(image.publicationId)),
          );
          if (record === undefined) continue;
          const service = await stack.catalogIn(image.wallet);
          const withdrawn = await Effect.runPromise(
            Effect.result(service.withdraw(record.ownership)),
          );
          if (Result.isFailure(withdrawn)) pending += 1;
          else removed += 1;
        }
        return { removed, pending };
      })().catch(() => ({ removed: 0, pending: 1 }));
      if (outcome !== undefined) report.push({ accountId: accountId ?? "default", ...outcome });
    }
    return report;
  };

  /** A check client for a key; probes name each wallet explicitly, with a bounded wait. */
  const probeClient = (credential: BoatSecret, wallet: string | null) =>
    (
      input.clientFor ??
      ((key, options) => HttpBoatApi.create({ credential: key, timeoutMs: 10_000, ...options }))
    )(credential, wallet === null ? undefined : { organization: wallet });
  /**
   * The key check's client: Boat's real API only in production, where no client factory is given.
   * A process given its own (`clientFor`, a test's fake) checks only through `keyClientFor`, and
   * without one resolves nothing: it never reaches Boat's real API by default.
   */
  const checkClient = (
    credential: BoatSecret,
  ): ReturnType<NonNullable<typeof input.keyClientFor>> =>
    input.keyClientFor !== undefined
      ? input.keyClientFor(credential)
      : input.clientFor === undefined
        ? HttpBoatApi.create({ credential, timeoutMs: 10_000 })
        : { ok: false, error: new BoatApiError("credential", null, "check_client_missing") };
  type Seen = "found" | "absent" | "unanswered";
  /** A process given any client factory of its own (a test) never reaches Boat's real API. */
  const faked =
    input.clientFor !== undefined ||
    input.keyClientFor !== undefined ||
    input.proofClientFor !== undefined;
  const missingClient = new BoatApiError("credential", null, "check_client_missing");
  /** Where something is: the one wallet that has it, nowhere (every wallet said so), or unknown. */
  const locate = async (
    wallets: readonly string[],
    read: (api: BoatApi) => Promise<Seen>,
    credential: BoatSecret,
  ): Promise<{ readonly in: string } | "nowhere" | "unanswered"> => {
    const seen = await Promise.all(
      wallets.map(async (wallet) => {
        const api = probeClient(credential, wallet);
        return [
          wallet,
          api.ok ? await read(api.value).catch((): Seen => "unanswered") : "unanswered",
        ] as const;
      }),
    );
    const found = seen.filter(([, each]) => each === "found");
    if (found.length === 1 && found[0] !== undefined) return { in: found[0][0] };
    return found.length === 0 && seen.every(([, each]) => each === "absent")
      ? "nowhere"
      : "unanswered";
  };

  /**
   * One pass over every owner sealant has not pinned (accounts connected before sealant pinned them,
   * the install's own key without a setting) and every object whose wallet sealant does not know.
   * An owner not pinned is pinned at once: to the install's setting, to an organization key's only
   * wallet, or to the wallet a personal key bills now (which needs `account.read`). The pin is for
   * what it makes from then on and waits for nothing it made before. Each object of unknown wallet
   * is then looked for, one at a time, under every wallet the key can bill, naming each: found in
   * one, that is recorded; found in none of a complete list, it is recorded unreachable (a run's VM
   * is then absent on that basis); Boat not answering, or no list, leaves only that object for the
   * next pass. An image build is reconciled by a catalog of its own whose builder does the same.
   * Then the install's setting is applied, if it changed.
   */
  const resolveWallets = async () => {
    const report: { accountId: string; outcome: string }[] = [];
    const targets: {
      readonly accountId: BoatAccountId;
      readonly owner: BoatWalletOwner;
      readonly deploymentId: string;
      readonly credential: () => Promise<BoatSecret | undefined>;
      readonly desired: string | undefined;
    }[] = [
      ...(fallback === undefined || envAccount === undefined
        ? []
        : [
            {
              accountId: null,
              owner: { install: { deploymentId: fallback.deploymentId } },
              deploymentId: fallback.deploymentId,
              credential: () => Promise.resolve(envAccount.credential),
              desired: envAccount.organization,
            },
          ]),
      ...(await directory.listUnresolved()).map((account) => ({
        accountId: account.id,
        owner: { accountId: account.id },
        deploymentId: account.deploymentId,
        credential: async () =>
          (await openStoredBoatKey({ db, cipher: credentialCipher }, account.id))?.credential,
        desired: undefined,
      })),
    ];
    const resolve = (owner: BoatWalletOwner, resolution: BoatWalletResolution) =>
      accountRepo(
        Effect.flatMap(BoatAccountRepo, (repo) => repo.resolveWallets(owner, resolution)),
      );
    const nothing = { runs: [], images: [], proofs: [] } as const;
    for (const target of targets) {
      const outcome = await (async () => {
        let current = await createWallet(target.accountId);
        // The install's setting names its wallet whatever the key can show.
        if (current.kind === "unresolved" && target.desired !== undefined) {
          await resolve(target.owner, {
            ...nothing,
            pin: { organization: target.desired, keyKind: null },
          });
          current = { kind: "known", wallet: target.desired };
        }
        const unknown = await accountRepo(
          Effect.flatMap(BoatAccountRepo, (repo) => repo.unknownObjects(target.owner)),
        );
        if (
          current.kind === "known" &&
          unknown.liveRuns.length === 0 &&
          unknown.images.length === 0 &&
          unknown.builds.length === 0 &&
          unknown.proofs.length === 0
        )
          return "resolved";
        // Each build, by a catalog of its own; one failing leaves only that build for the next pass.
        if (unknown.builds.length > 0) {
          const stack = await stackOf(target.accountId).catch(() => undefined);
          for (const publicationId of unknown.builds)
            await stack?.reconcileBuild?.(publicationId).catch(() => undefined);
        }
        const credential = await target.credential();
        if (credential === undefined) return "unavailable";
        const client = checkClient(credential);
        if (!client.ok) return "unavailable";
        const check = await checkBoatKey(client.value, { organization: null }).catch(
          () => undefined,
        );
        if (check?.kind !== "checked") return "unavailable";
        const observed = check.report;
        const keyKind = observed.keyKind.observed ? observed.keyKind.kind : null;
        if (keyKind === "organization")
          return resolve(target.owner, {
            runs: unknown.liveRuns.map((run) => ({ runId: run.runId, wallet: null })),
            images: unknown.images.map((image) => ({
              publicationId: image.publicationId,
              wallet: null,
            })),
            proofs: unknown.proofs.map((proof) => ({ id: proof.id, wallet: null })),
            pin: { organization: null, keyKind: "organization" },
          });
        const billed = !observed.wallet.observed
          ? undefined
          : observed.wallet.kind === "personal"
            ? "personal"
            : observed.wallet.organizationId;
        // Pinned now, before anything is looked for: nothing it made before waits on the pin.
        if (current.kind === "unresolved") {
          if (billed === undefined) return "unavailable";
          await resolve(target.owner, { ...nothing, pin: { organization: billed, keyKind } });
        }
        const wallets =
          observed.wallets?.observed === true
            ? observed.wallets.choices.map((choice) => choice.id)
            : undefined;
        // Without the list, sealant looks where it can, and a miss there proves nothing.
        const complete = wallets !== undefined;
        const searched = wallets ?? [
          ...new Set([billed, target.desired, "personal"].filter((each) => each !== undefined)),
        ];
        const runs = await pooled(
          unknown.liveRuns.map((run) => async () => {
            // A create whose VM is not on record is found by its run's own convergence.
            if (run.sandboxId === null) return undefined;
            const id = boatSandboxIdSchema.safeParse(run.sandboxId);
            if (!id.success) return undefined;
            const found = await locate(
              searched,
              async (api) => {
                const read = await api.get(id.data);
                if (read.ok)
                  return read.value.labels?.["sealant-deployment"] === target.deploymentId
                    ? "found"
                    : "absent";
                return read.error.status === 404 ? "absent" : "unanswered";
              },
              credential,
            );
            return typeof found === "object"
              ? { runId: run.runId, wallet: found.in }
              : found === "nowhere" && complete
                ? { runId: run.runId, unreachable: true as const }
                : undefined;
          }),
        );
        const images = await pooled(
          unknown.images.map((image) => async () => {
            const name = boatSnapshotNameSchema.safeParse(image.name);
            if (!name.success) return undefined;
            const found = await locate(
              searched,
              async (api) => {
                const read = await api.getSnapshot(name.data);
                return read.ok ? "found" : read.error.status === 404 ? "absent" : "unanswered";
              },
              credential,
            );
            return typeof found === "object"
              ? { publicationId: image.publicationId, wallet: found.in }
              : found === "nowhere" && complete
                ? { publicationId: image.publicationId, unreachable: true as const }
                : undefined;
          }),
        );
        const proofs = await pooled(
          unknown.proofs.map((proof) => async () => {
            const found = await locate(
              searched,
              async (api): Promise<Seen> => {
                const vm = boatSandboxIdSchema.safeParse(proof.sandboxId);
                const snapshot = boatSnapshotNameSchema.safeParse(proof.snapshotName);
                const reads: Seen[] = [];
                if (vm.success) {
                  const read = await api.get(vm.data);
                  reads.push(
                    read.ok ? "found" : read.error.status === 404 ? "absent" : "unanswered",
                  );
                }
                if (snapshot.success) {
                  const read = await api.getSnapshot(snapshot.data);
                  reads.push(
                    read.ok ? "found" : read.error.status === 404 ? "absent" : "unanswered",
                  );
                }
                return reads.includes("found")
                  ? "found"
                  : reads.includes("unanswered")
                    ? "unanswered"
                    : "absent";
              },
              credential,
            );
            return typeof found === "object"
              ? { id: proof.id, wallet: found.in }
              : found === "nowhere" && complete
                ? { id: proof.id, unreachable: true as const }
                : undefined;
          }),
        );
        await resolve(target.owner, {
          runs: runs.filter((each) => each !== undefined),
          images: images.filter((each) => each !== undefined),
          proofs: proofs.filter((each) => each !== undefined),
        });
        return current.kind === "unresolved" ? "pinned" : "recorded";
      })().catch(() => "unavailable");
      if (outcome === "pinned" && target.accountId !== null) directory.forget(target.accountId);
      if (outcome !== "resolved")
        report.push({ accountId: target.accountId ?? "default", outcome });
    }
    // The install's setting, if it names another wallet than the one applied: what the install makes
    // from then on is made there; nothing it made before waits.
    const desired = envAccount?.organization;
    if (desired !== undefined && fallback !== undefined) {
      const applied = await accountRepo(
        Effect.flatMap(BoatAccountRepo, (repo) => repo.installWallet()),
      );
      if (applied?.organization != null && applied.organization !== desired) {
        const changed = await accountRepo(
          Effect.flatMap(BoatAccountRepo, (repo) =>
            repo.changeOrganization(
              { install: { deploymentId: fallback.deploymentId } },
              { organization: desired, expected: applied.organization },
            ),
          ),
        ).catch(() => undefined);
        report.push({ accountId: "default", outcome: `setting-${changed?.kind ?? "unavailable"}` });
      }
    }
    return report;
  };

  /**
   * One Boat image retention pass: in the install's own account and every stored account not
   * being removed (a removal deletes every image of its account itself), each saved image no
   * workspace can use any more is removed. Per account: what it removed, kept, or could not
   * remove yet (an obligation the next pass, or the journal sweep, finishes).
   */
  const reapImages = async (policy: BoatImageRetention) => {
    const accounts: BoatAccountId[] = [
      ...(fallback === undefined ? [] : [null]),
      ...(await directory.list())
        .filter((account) => account.removalRequestedAt === null)
        .map((account) => account.id),
    ];
    const report: {
      readonly accountId: string;
      readonly removed: number;
      readonly kept: number;
      readonly obligations: readonly { readonly id: string; readonly code: string }[];
    }[] = [];
    for (const accountId of accounts) {
      const entries = await (async () => {
        const stack = await stackOf(accountId);
        return stack?.reapImages?.(policy);
      })().catch(() => [{ id: "pass", outcome: "obligation" as const, code: "retention-failed" }]);
      if (entries === undefined) continue;
      report.push({
        accountId: accountId ?? "default",
        removed: entries.filter((entry) => entry.outcome === "updated").length,
        kept: entries.filter((entry) => entry.outcome === "skipped").length,
        obligations: entries
          .filter((entry) => entry.outcome === "obligation")
          .map(({ id, code }) => ({ id, code })),
      });
    }
    return report;
  };

  // At start, where unpinned owners' things are, then the install's own catalog in the wallet it
  // makes things in (none while its key is not pinned): in the background, so a Boat that does not
  // answer delays nothing. The sweep tick goes on from there.
  const startup = resolveWallets()
    .then(() => fallback?.catalog())
    .then(
      () => undefined,
      () => undefined,
    );

  const launchReport = {
    launches: registration !== undefined,
    defaultAccount: registration !== undefined && fallback !== undefined,
    resourceGateway: registration !== undefined && gateway !== undefined,
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
    /** One pass of the changes of organization (`reconcileOrganizationChanges` above). */
    /** One pass that finds where unknown objects are and pins the owners sealant has not pinned. */
    resolveWallets,
    /** The pass above as the worker's start runs it, which nothing in the worker waits on. */
    startup,
    /**
     * One pass over what is recorded in another wallet than its account's now: unfinished builds
     * reconciled there, and saved images removed there.
     */
    removeImagesElsewhere: registration === undefined ? undefined : removeImagesElsewhere,
    /** One image retention pass (`reapImages` above); only a worker that builds images has one. */
    reapImages: registration === undefined ? undefined : reapImages,
    /**
     * What this worker does for Boat, as the API reads it (`boat_launch_reports`): whether it
     * launches Boat workspaces, in the install's own account too, and with the resource gateway.
     */
    launchReport,
    /**
     * One pass of the full checks' sweep: whatever an interrupted check, or one whose cleanup Boat
     * refused, still holds in Boat (its VM, its snapshot) is deleted with its account's key.
     */
    sweepKeyProofs: async (now?: Date) => {
      const proofs = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* BoatKeyProofRepo;
        }).pipe(Effect.provide(BoatKeyProofRepoLive), Effect.provideService(SealantDB, db)),
      );
      // Boat's real API only where no client factory is given at all (production).
      const open =
        input.proofClientFor ??
        (faked
          ? () => ({ ok: false, error: missingClient }) as const
          : (credential: BoatSecret, options?: { readonly organization?: string }) =>
              HttpBoatApi.create({
                credential,
                ...(options?.organization === undefined
                  ? {}
                  : { organization: options.organization }),
              }));
      return sweepBoatKeyProofs({
        proofs,
        ...(now === undefined ? {} : { now: () => now }),
        // The wallet each check was recorded in, never the account's current one; for one made
        // before sealant recorded wallets, the account's own client, which finds it.
        clientFor: async (account, wallet): Promise<BoatKeyProofClient | undefined> => {
          const key =
            account === "default"
              ? defaultKey
              : await openStoredBoatKey({ db, cipher: credentialCipher }, account);
          if (key === undefined) return undefined;
          const client = open(
            key.credential,
            wallet === null || wallet === undefined ? undefined : { organization: wallet },
          );
          if (!client.ok) return undefined;
          if (wallet !== undefined) return client.value;
          const routed =
            account === "default" ? defaultProvider?.api : (await directory.provider(account))?.api;
          if (routed === undefined) return undefined;
          // Every request about its VM or snapshot finds the wallet they are in; the listing of an
          // unfinished check's create names none, as the released sealant did.
          const released = client.value;
          return {
            create: (...args) => routed.create(...args),
            get: (...args) => routed.get(...args),
            execute: (...args) => routed.execute(...args),
            hostControl: (...args) => routed.hostControl(...args),
            saveSnapshot: (...args) => routed.saveSnapshot(...args),
            getSnapshot: (...args) => routed.getSnapshot(...args),
            deleteSnapshot: (...args) => routed.deleteSnapshot(...args),
            deleteSandbox: (...args) => routed.deleteSandbox(...args),
            findKeyProof: (...args) => released.findKeyProof(...args),
          };
        },
      });
    },
    /** Writes this worker's launch report (`launchReport`), stamped by the database's clock. */
    reportLaunch: async (worker: string, observedAt?: Date) => {
      // The install's own account launches only once sealant knows which wallet its key bills: until
      // then this worker says it cannot, and the API refuses a create that would need it.
      const installReady =
        launchReport.defaultAccount &&
        (await createWallet(null).catch(() => ({ kind: "unresolved" }) as const)).kind === "known";
      await Effect.runPromise(
        Effect.flatMap(BoatAccountRepo, (repo) =>
          repo.reportLaunch({
            worker,
            ...launchReport,
            defaultAccount: installReady,
            ...(observedAt === undefined ? {} : { observedAt }),
          }),
        ).pipe(Effect.provide(BoatAccountRepoLive), Effect.provideService(SealantDB, db)),
      );
    },
    /**
     * One pass of the key reports: every key whose report is older than a day (or `force`d) is
     * checked against Boat again and its report replaced; Boat not answering keeps the last one.
     */
    refreshKeyReports: (pass?: {
      readonly force?: readonly string[];
      readonly now?: () => Date;
      readonly everyMs?: number;
    }): Promise<readonly BoatKeyRefreshOutcome[]> =>
      refreshBoatKeyReports(
        {
          db,
          cipher: credentialCipher,
          ...(defaultKey === undefined ? {} : { defaultKey }),
          ...(input.keyClientFor !== undefined
            ? { clientFor: input.keyClientFor }
            : faked
              ? { clientFor: () => ({ ok: false, error: missingClient }) as const }
              : {}),
          ...(pass?.now === undefined ? {} : { now: pass.now }),
          ...(pass?.everyMs === undefined ? {} : { everyMs: pass.everyMs }),
        },
        pass?.force === undefined ? {} : { force: pass.force },
      ),
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
