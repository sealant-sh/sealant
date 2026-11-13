import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import { BoatRunRepo, BoatRunRepoLive, SealantDB, type DB } from "@sealant/db";
import { Effect, Layer, ManagedRuntime } from "effect";

import { boatAccountControl } from "./account-router.js";
import { BoatAccountDirectory, type BoatAccountId, type BoatClientFactory } from "./accounts.js";
import type { BoatApi } from "./api.js";
import { BoatControlMaterial, boatControlMaterialLayer } from "./control-material.js";
import { boatInstallNames } from "./provider-env.js";
import { BoatAllocationProvider } from "./provider.js";

/**
 * The API's Boat control over every account of the install: a connection to a run is opened with
 * the key of the account the run was created under. Each account's control is built once, on the
 * first connection to one of its runs, and kept for the process.
 */
export const boatAccountControlMaterial = (input: {
  readonly db: DB;
  readonly cipher: CredentialCipherService;
  readonly directory: BoatAccountDirectory;
}): { readonly service: BoatControlMaterial["Service"]; readonly dispose: () => Promise<void> } => {
  const Infra = Layer.mergeAll(
    Layer.succeed(SealantDB, input.db),
    Layer.succeed(CredentialCipher, input.cipher),
  );
  const repos = ManagedRuntime.make(BoatRunRepoLive.pipe(Layer.provide(Infra)));
  const runtimes = new Map<
    string,
    Promise<ManagedRuntime.ManagedRuntime<BoatControlMaterial, never> | undefined>
  >();
  const controlOf = (accountId: BoatAccountId) => {
    const key = accountId ?? "default";
    let runtime = runtimes.get(key);
    if (runtime === undefined) {
      runtime = input.directory.provider(accountId).then((provider) =>
        provider === undefined
          ? undefined
          : ManagedRuntime.make(
              boatControlMaterialLayer.pipe(
                Layer.provide(
                  Layer.merge(
                    Infra,
                    Layer.succeed(BoatAllocationProvider, {
                      deploymentId: provider.deploymentId,
                      ...(provider.accountId === null ? {} : { accountId: provider.accountId }),
                      api: provider.api,
                    }),
                  ),
                ),
              ),
            ),
      );
      runtimes.set(key, runtime);
      const pending = runtime;
      // Nothing known of it yet (an unknown id, a store that failed): asked again next time.
      void (async () => {
        if ((await pending.catch(() => undefined)) === undefined && runtimes.get(key) === pending)
          runtimes.delete(key);
      })();
    }
    return runtime;
  };
  const service = boatAccountControl(async (runId) => {
    const run = await repos.runPromise(Effect.flatMap(BoatRunRepo, (runs) => runs.get(runId)));
    if (run === undefined) return undefined;
    const runtime = await controlOf(run.accountId);
    return runtime === undefined ? undefined : runtime.runPromise(BoatControlMaterial);
  });
  return {
    service,
    dispose: async () => {
      for (const runtime of runtimes.values())
        await (await runtime.catch(() => undefined))?.dispose();
      await repos.dispose();
    },
  };
};

/**
 * The same control as a layer, for a process root that holds its database and cipher as services:
 * the API's. `defaultAccount` is the env key's client, where the install has one, and the deployment
 * its env names; without one, the install's stored name (`boatInstallNames`), the worker's too. An
 * install with no env key still opens its stored accounts' runs.
 */
export const boatAccountControlMaterialLayer = (options: {
  readonly defaultAccount?: { readonly deploymentId: string | undefined; readonly api: BoatApi };
  readonly clientFor?: BoatClientFactory;
}): Layer.Layer<BoatControlMaterial, never, SealantDB | CredentialCipher> => {
  // Read once per process, not once per build of the layer: the name never changes.
  let deployment: Promise<string> | undefined;
  const deploymentOf = (db: DB, preferred: string | undefined) => {
    deployment ??= boatInstallNames({ deploymentId: preferred, withBuilder: false }, db).then(
      (names) => names.deploymentId,
    );
    deployment.catch(() => {
      // A failed read is tried again by the next build.
      deployment = undefined;
    });
    return deployment;
  };
  return Layer.effect(
    BoatControlMaterial,
    Effect.gen(function* () {
      const db = yield* SealantDB;
      const cipher = yield* CredentialCipher;
      const fallback = options.defaultAccount;
      const defaultAccount =
        fallback === undefined
          ? undefined
          : {
              api: fallback.api,
              deploymentId: yield* Effect.promise(() => deploymentOf(db, fallback.deploymentId)),
            };
      const directory = new BoatAccountDirectory({
        db,
        cipher,
        ...(defaultAccount === undefined ? {} : { defaultAccount }),
        ...(options.clientFor === undefined ? {} : { clientFor: options.clientFor }),
      });
      const made = boatAccountControlMaterial({ db, cipher, directory });
      yield* Effect.addFinalizer(() => Effect.promise(made.dispose));
      return made.service;
    }),
  );
};
