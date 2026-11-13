import type { NativeCatalogStoreError } from "@sealant/db";
import type { NativeBuildOwnership, NativePublication } from "@sealant/validators";
import { Effect } from "effect";

import {
  NativeCatalogError,
  type BoatNativeCatalogService,
  type NativeAcquireInput,
} from "../../images/boat/catalog.js";
import { failLaunch, type RuntimeAdapterLaunchHooks } from "../launch-retention.js";
import {
  removalRefused,
  type RuntimeAdapter,
  type RuntimeAdapterInspectInput,
  type RuntimeAdapterInspectResult,
  type RuntimeAdapterRecoverInput,
  type RuntimeAdapterRecoverResult,
  type RuntimeAdapterStopInput,
  type RuntimeLaunch,
} from "../runtime-adapter.js";
import type { BoatAccountId } from "./accounts.js";
import { BoatAdapterError, boatAdapterSupports, type BoatRuntimeAdapter } from "./adapter.js";
import { BoatControlError, type BoatControlMaterial } from "./control-material.js";

/** What one Boat account runs in this process: its adapter, its control, its image catalog. */
export interface BoatAccountStack {
  readonly accountId: BoatAccountId;
  readonly deploymentId: string;
  /** Absent on a worker that only resolves creates (the Boat key and no builder or gateway). */
  readonly adapter: BoatRuntimeAdapter | undefined;
  readonly control: BoatControlMaterial["Service"] | undefined;
  /**
   * The account's image catalog, made on first use: a stored account's catalog and builder exist
   * only once it launches (or holds images to remove). `undefined` where this worker builds none.
   */
  readonly catalog: () => Promise<BoatNativeCatalogService | undefined>;
}

/** How a call finds the stack of the account it is for. */
export interface BoatAccountStacks {
  /**
   * The stack of an account, for a launch: `undefined` for an unknown or removed account, one
   * whose removal was asked, or the default account on an install that has no env key.
   */
  readonly launching: (accountId: BoatAccountId) => Promise<BoatAccountStack | undefined>;
  /** The stack of the account a run was created under, whatever has become of the account since. */
  readonly ofRun: (runId: string) => Promise<BoatAccountStack | undefined>;
  /** The stack of the account whose run names this VM; `undefined` when no run does. */
  readonly ofSandbox: (sandboxId: string) => Promise<BoatAccountStack | undefined>;
  /** The stack of the account whose catalog owns this deployment label. */
  readonly ofDeployment: (deploymentId: string) => Promise<BoatAccountStack | undefined>;
  /** The install's default account's stack, where it has one. */
  readonly fallback: BoatAccountStack | undefined;
}

/** The account a workspace's spec names, or the install's default one. */
export const boatAccountOf = (blueprint: {
  readonly runtime: { readonly boatAccountId?: string | undefined };
}): BoatAccountId => blueprint.runtime.boatAccountId ?? null;

const accountUnavailable = () =>
  new BoatAdapterError("admission-refused", {
    step: "prepare-launch",
    errorClass: "BoatAdapterError",
    code: "account-unavailable",
  });

/**
 * Boat's one runtime adapter on a worker, over every Boat account of the install. A launch runs in
 * the account its workspace's spec names (`runtime.boatAccountId`, absent: the default account);
 * every later call for a run (stop, inspect, recover, locate) goes to the account the run was
 * created under, found from its row, so a run never leaves its account and never meets another
 * account's key. What a VM no run of this install names is answered as the default account's
 * adapter answers it.
 */
export class BoatAccountRouterAdapter implements RuntimeAdapter<NativePublication> {
  readonly id = "boat" as const;
  readonly stopRequestBeforeDrain = true;
  readonly reportsMissingAsLost = true;
  readonly recoverAnswersUnstarted = true;

  constructor(
    private readonly options: {
      readonly stacks: BoatAccountStacks;
      /** Whether this install has a resource gateway: the same for every account. */
      readonly resourceGateway: boolean;
    },
  ) {}

  supports(input: Parameters<RuntimeAdapter<NativePublication>["supports"]>[0]) {
    return boatAdapterSupports(input, this.options.resourceGateway);
  }

  async launch(raw: RuntimeLaunch<NativePublication>, hooks?: RuntimeAdapterLaunchHooks) {
    const stack = await this.options.stacks
      .launching(boatAccountOf(raw.blueprint))
      .catch(() => undefined);
    // Refused before anything is asked of Boat: no VM exists, and none is made.
    if (stack?.adapter === undefined)
      return failLaunch({
        blueprint: raw.blueprint,
        identity: undefined,
        runtime: "running",
        error: accountUnavailable(),
      });
    return stack.adapter.launch(raw, hooks);
  }

  async locate(input: { readonly runId: string }) {
    const stack = await this.options.stacks.ofRun(input.runId);
    return stack?.adapter?.locate(input);
  }

  /** The adapter that answers for a VM: its run's account's, or the default one's. */
  async #forSandbox(sandboxId: string) {
    return (
      (await this.options.stacks.ofSandbox(sandboxId))?.adapter ??
      this.options.stacks.fallback?.adapter
    );
  }

  async stop(input: RuntimeAdapterStopInput) {
    const adapter = await this.#forSandbox(input.resourceId).catch(() => {
      throw removalRefused(new BoatAdapterError("close-unavailable"));
    });
    if (adapter === undefined) throw removalRefused(new BoatAdapterError("target-mismatch"));
    return adapter.stop(input);
  }

  async inspect(input: RuntimeAdapterInspectInput): Promise<RuntimeAdapterInspectResult> {
    // Unknown is never an exit and never absence.
    const adapter = await this.#forSandbox(input.resourceId).catch(() => undefined);
    return adapter === undefined ? { state: "running" } : adapter.inspect(input);
  }

  async recover(input: RuntimeAdapterRecoverInput): Promise<RuntimeAdapterRecoverResult> {
    const adapter = await this.#forSandbox(input.resourceId);
    if (adapter === undefined)
      return {
        outcome: "unsupported",
        detail: `no Boat run of this install names VM ${input.resourceId}; it is not this adapter's to recover`,
      };
    return adapter.recover(input);
  }
}

const catalogUnavailable = (detail: string) =>
  new NativeCatalogError("invalid-input", undefined, detail);

/**
 * Boat's image catalog over every account of the install: each account's saved images live in
 * that Boat account, so each has its own publications (keyed by its deployment label) and its own
 * builds. An acquire runs in the account the workspace's spec names, and builds there on that
 * account's first launch. Pins are the catalog repository's and the same for every account.
 */
export const boatAccountCatalog = (input: {
  readonly stacks: BoatAccountStacks;
  /** The repository-level pin writes, which no account's builder takes part in. */
  readonly pins: Pick<BoatNativeCatalogService, "markConsumer" | "release">;
}): BoatNativeCatalogService => {
  const catalogOf = (stack: Promise<BoatAccountStack | undefined>, detail: string) =>
    Effect.tryPromise({
      try: async () => (await stack)?.catalog(),
      catch: () => catalogUnavailable(detail),
    }).pipe(
      Effect.flatMap((catalog) =>
        catalog === undefined ? Effect.fail(catalogUnavailable(detail)) : Effect.succeed(catalog),
      ),
    );
  const byDeployment = (deploymentId: string) =>
    catalogOf(input.stacks.ofDeployment(deploymentId), "boat-account-unavailable");
  return {
    acquire: (acquire: NativeAcquireInput) =>
      catalogOf(
        input.stacks.launching(boatAccountOf(acquire.spec)),
        "boat-account-unavailable",
      ).pipe(Effect.flatMap((catalog) => catalog.acquire(acquire))),
    markConsumer: input.pins.markConsumer,
    release: input.pins.release,
    withdraw: (ownership: NativeBuildOwnership) =>
      byDeployment(ownership.key.deploymentId).pipe(
        Effect.flatMap((catalog) => catalog.withdraw(ownership)),
      ),
    // Retention is per account: the worker's Boat sweep runs each account's own catalog's
    // `reap`, which knows the account's deployment and the workspaces that run in it.
    reap: () =>
      Effect.fail<NativeCatalogError | NativeCatalogStoreError>(
        catalogUnavailable("reap-per-account"),
      ),
    reconcile: () =>
      Effect.fail<NativeCatalogError | NativeCatalogStoreError>(
        catalogUnavailable("reconcile-per-account"),
      ),
  };
};

/**
 * Boat control material over every account of the install: each connection is opened by the
 * account its run was created under, with that account's key, and refused for a run no account
 * of this install has.
 */
export const boatAccountControl = (
  ofRun: (runId: string) => Promise<BoatControlMaterial["Service"] | undefined>,
): BoatControlMaterial["Service"] => {
  const routed = (runId: string) =>
    Effect.tryPromise({
      try: () => ofRun(runId),
      catch: () => new BoatControlError("unavailable"),
    }).pipe(
      Effect.flatMap((control) =>
        control === undefined
          ? Effect.fail(new BoatControlError("refused"))
          : Effect.succeed(control),
      ),
    );
  return {
    connectMaterial: (runId, sandboxId) =>
      routed(runId).pipe(Effect.flatMap((control) => control.connectMaterial(runId, sandboxId))),
    drainMaterial: (runId, sandboxId) =>
      routed(runId).pipe(Effect.flatMap((control) => control.drainMaterial(runId, sandboxId))),
  };
};
