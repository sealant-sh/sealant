import type { CredentialCipherService } from "@sealant/credentials";
import {
  BoatAccountRepo,
  BoatAccountRepoLive,
  SealantDB,
  type BoatAccountRecord,
  type DB,
} from "@sealant/db";
import { Effect, Option } from "effect";

import { HttpBoatApi, type BoatApi } from "./api.js";
import { BoatApiError, BoatSecret, type BoatResult } from "./config.js";

/**
 * Which Boat account a call is for: a stored account's id, or `null` for the install's default
 * account (the env key). Every run made before accounts existed is the default account's.
 */
export type BoatAccountId = string | null;

/** What one Boat account gives every Boat owner built for it: its client and its names. */
export interface BoatAccountProvider {
  readonly accountId: BoatAccountId;
  /** The `sealant-deployment` label of every VM and image sealant makes in the account. */
  readonly deploymentId: string;
  /** The `sealant-owner` of every image sealant builds in the account; absent: none is built. */
  readonly builderOwner: string | undefined;
  /** The account's client. For a stored account it always calls Boat with the current key. */
  readonly api: BoatApi;
}

/** How a process opens a Boat key into a client: Boat's real API, or a recorded fake in tests. */
export type BoatClientFactory = (
  credential: BoatSecret,
  options?: {
    /** The Boat organization the account bills, sent as `X-Boat-Org` on every request. */
    readonly organization?: string;
  },
) => BoatResult<BoatApi>;

export const httpBoatClientFactory: BoatClientFactory = (credential, options) =>
  HttpBoatApi.create({
    credential,
    ...(options?.organization === undefined ? {} : { organization: options.organization }),
  });

/** A stored account's key could not be opened: removed, unreadable, or not a Boat key. */
const keyUnavailable = (operation: string) =>
  new BoatApiError(operation, null, "account_key_unavailable");

/**
 * A stored account's client: every call opens the account's current key first, so a rotation
 * reaches every Boat owner that holds this client without rebuilding any of them. The key is read
 * again when its revision changes, which is checked at most once per `revisionCheckMs`.
 */
class StoredAccountApi implements BoatApi {
  readonly #resolve: (fresh: boolean) => Promise<BoatResult<BoatApi>>;
  constructor(resolve: (fresh: boolean) => Promise<BoatResult<BoatApi>>) {
    this.#resolve = resolve;
  }
  #open(operation: string, fresh: boolean) {
    return this.#resolve(fresh).catch(
      (): BoatResult<BoatApi> => ({ ok: false, error: keyUnavailable(operation) }),
    );
  }
  /**
   * Calls Boat with the account's current key. Boat refusing the key (401, 403) may mean it was
   * rotated a moment ago: the key is read again at once, and the call is made once more only if
   * that opened another key. Every Boat call here is safe to repeat: a create carries its
   * idempotency key, and a refused call changed nothing.
   */
  async #with<A>(
    operation: string,
    call: (api: BoatApi) => Promise<BoatResult<A>>,
  ): Promise<BoatResult<A>> {
    const api = await this.#open(operation, false);
    if (!api.ok) return { ok: false, error: api.error };
    const answered = await call(api.value);
    if (answered.ok || (answered.error.status !== 401 && answered.error.status !== 403))
      return answered;
    const again = await this.#open(operation, true);
    return again.ok && again.value !== api.value ? call(again.value) : answered;
  }
  create(...args: Parameters<BoatApi["create"]>) {
    return this.#with("create", (api) => api.create(...args));
  }
  async discover(...args: Parameters<BoatApi["discover"]>) {
    const api = await this.#open("discover", false);
    if (!api.ok)
      return { kind: "unknown", reason: "inventory-unavailable", error: api.error } as const;
    const found = await api.value.discover(...args);
    if (
      found.kind !== "unknown" ||
      found.reason !== "inventory-unavailable" ||
      (found.error.status !== 401 && found.error.status !== 403)
    )
      return found;
    const again = await this.#open("discover", true);
    return again.ok && again.value !== api.value ? again.value.discover(...args) : found;
  }
  get(...args: Parameters<BoatApi["get"]>) {
    return this.#with("get", (api) => api.get(...args));
  }
  execute(...args: Parameters<BoatApi["execute"]>) {
    return this.#with("execute", (api) => api.execute(...args));
  }
  writeFile(...args: Parameters<BoatApi["writeFile"]>) {
    return this.#with("writeFile", (api) => api.writeFile(...args));
  }
  uploadFile(...args: Parameters<BoatApi["uploadFile"]>) {
    return this.#with("uploadFile", (api) => api.uploadFile(...args));
  }
  hostControl(...args: Parameters<BoatApi["hostControl"]>) {
    return this.#with("hostControl", (api) => api.hostControl(...args));
  }
  stop(...args: Parameters<BoatApi["stop"]>) {
    return this.#with("stop", (api) => api.stop(...args));
  }
  resume(...args: Parameters<BoatApi["resume"]>) {
    return this.#with("resume", (api) => api.resume(...args));
  }
  deleteSandbox(...args: Parameters<BoatApi["deleteSandbox"]>) {
    return this.#with("deleteSandbox", (api) => api.deleteSandbox(...args));
  }
  getDeletion(...args: Parameters<BoatApi["getDeletion"]>) {
    return this.#with("getDeletion", (api) => api.getDeletion(...args));
  }
  saveSnapshot(...args: Parameters<BoatApi["saveSnapshot"]>) {
    return this.#with("saveSnapshot", (api) => api.saveSnapshot(...args));
  }
  getSnapshot(...args: Parameters<BoatApi["getSnapshot"]>) {
    return this.#with("getSnapshot", (api) => api.getSnapshot(...args));
  }
  deleteSnapshot(...args: Parameters<BoatApi["deleteSnapshot"]>) {
    return this.#with("deleteSnapshot", (api) => api.deleteSnapshot(...args));
  }
}

export interface BoatAccountDirectoryOptions {
  readonly db: DB;
  readonly cipher: CredentialCipherService;
  /** The install's default account, from its env; absent when the install has no env key. */
  readonly defaultAccount?: {
    readonly deploymentId: string;
    readonly api: BoatApi;
    readonly builderOwner?: string | undefined;
  };
  /** Default: Boat's real API. */
  readonly clientFor?: BoatClientFactory;
  /** How often a stored account's key revision is read again. Default 10 s; 0 reads every call. */
  readonly revisionCheckMs?: number;
}

/**
 * The Boat accounts of an install, by id, each with one client. A stored account's provider is
 * made once per process and kept; its client opens the sealed key on first use, and opens it
 * again when the account's key revision changes (a rotation). No call here reaches Boat.
 */
export class BoatAccountDirectory {
  readonly #options: BoatAccountDirectoryOptions;
  readonly #providers = new Map<string, BoatAccountProvider>();
  readonly #clients = new Map<
    string,
    { readonly revision: number; readonly api: BoatApi; checkedAt: number }
  >();

  constructor(options: BoatAccountDirectoryOptions) {
    this.#options = options;
  }

  #run<A, E>(effect: Effect.Effect<A, E, BoatAccountRepo>): Promise<A> {
    return Effect.runPromise(
      effect.pipe(
        Effect.provide(BoatAccountRepoLive),
        Effect.provideService(SealantDB, this.#options.db),
      ),
    );
  }

  /** The stored account, whatever its state, removed included; never its key. */
  account(accountId: string): Promise<BoatAccountRecord | undefined> {
    return this.#run(Effect.flatMap(BoatAccountRepo, (repo) => repo.get(accountId)));
  }

  /** The account a deployment label belongs to: the default one's, or a stored account's. */
  async accountOfDeployment(deploymentId: string): Promise<BoatAccountId | undefined> {
    if (this.#options.defaultAccount?.deploymentId === deploymentId) return null;
    const account = await this.#run(
      Effect.flatMap(BoatAccountRepo, (repo) => repo.getByDeployment(deploymentId)),
    );
    return account === undefined || account.removedAt !== null ? undefined : account.id;
  }

  /** Every stored account not removed. */
  list(): Promise<readonly BoatAccountRecord[]> {
    return this.#run(Effect.flatMap(BoatAccountRepo, (repo) => repo.list()));
  }

  /** The stored accounts not removed that have ever had a run: the ones Boat's sweeps visit. */
  listWithRuns(): Promise<readonly BoatAccountRecord[]> {
    return this.#run(Effect.flatMap(BoatAccountRepo, (repo) => repo.listWithRuns()));
  }

  /** The accounts whose removal was asked and is not finished. */
  listRemoving(): Promise<readonly BoatAccountRecord[]> {
    return this.#run(Effect.flatMap(BoatAccountRepo, (repo) => repo.listRemoving()));
  }

  /**
   * The removal's end, once Boat holds nothing sealant made under the key: the sealed key is erased
   * and the account's client forgotten. `held`: something is still there; nothing changed.
   */
  async finishRemoval(accountId: string): Promise<"removed" | "held"> {
    const outcome = await this.#run(
      Effect.flatMap(BoatAccountRepo, (repo) => repo.finishRemoval(accountId)),
    );
    if (outcome === "removed") {
      this.#providers.delete(accountId);
      this.#clients.delete(accountId);
    }
    return outcome;
  }

  /**
   * The account's provider, or `undefined`: the default account on an install with no env key,
   * or a stored account that is unknown or removed. An account whose removal was asked still has
   * one, for the work its removal waits on.
   */
  async provider(accountId: BoatAccountId): Promise<BoatAccountProvider | undefined> {
    if (accountId === null) {
      const fallback = this.#options.defaultAccount;
      return fallback === undefined
        ? undefined
        : {
            accountId: null,
            deploymentId: fallback.deploymentId,
            builderOwner: fallback.builderOwner,
            api: fallback.api,
          };
    }
    const known = this.#providers.get(accountId);
    if (known !== undefined) return known;
    const account = await this.account(accountId);
    if (account === undefined || account.removedAt !== null) return undefined;
    const provider: BoatAccountProvider = {
      accountId,
      deploymentId: account.deploymentId,
      builderOwner: account.builderOwner,
      api: new StoredAccountApi((fresh) => this.#client(accountId, fresh)),
    };
    this.#providers.set(accountId, provider);
    return provider;
  }

  /**
   * The account's client on its current key, opened again only when the key was rotated. `fresh`:
   * the revision is read now, whenever it was last read (Boat refused the cached key).
   */
  async #client(accountId: string, fresh: boolean): Promise<BoatResult<BoatApi>> {
    const now = Date.now();
    const cached = this.#clients.get(accountId);
    const every = this.#options.revisionCheckMs ?? 10_000;
    if (!fresh && cached !== undefined && now - cached.checkedAt < every)
      return { ok: true, value: cached.api };
    const revision = await this.#run(
      Effect.flatMap(BoatAccountRepo, (repo) => repo.keyRevision(accountId)),
    );
    if (revision === undefined) {
      this.#clients.delete(accountId);
      return { ok: false, error: keyUnavailable("credential") };
    }
    if (cached !== undefined && cached.revision === revision) {
      cached.checkedAt = now;
      return { ok: true, value: cached.api };
    }
    const sealed = await this.#run(
      Effect.flatMap(BoatAccountRepo, (repo) => repo.sealedKey(accountId)),
    );
    if (sealed === undefined) return { ok: false, error: keyUnavailable("credential") };
    const opened = await Effect.runPromise(
      this.#options.cipher.decrypt(sealed.sealedKey).pipe(Effect.option),
    );
    if (Option.isNone(opened)) return { ok: false, error: keyUnavailable("credential") };
    const credential = BoatSecret.parse(opened.value);
    if (!credential.ok) return { ok: false, error: keyUnavailable("credential") };
    // The organization the account was stored with: every request for it bills that one.
    const api = (this.#options.clientFor ?? httpBoatClientFactory)(
      credential.value,
      sealed.organization === null ? undefined : { organization: sealed.organization },
    );
    if (!api.ok) return api;
    this.#clients.set(accountId, { revision: sealed.keyRevision, api: api.value, checkedAt: now });
    return api;
  }
}
