import type { CredentialCipherService } from "@sealant/credentials";
import {
  BoatAccountRepo,
  BoatAccountRepoLive,
  SealantDB,
  createBoatWalletOf,
  type BoatAccountRecord,
  type BoatCreateWallet,
  type BoatObjectRef,
  type BoatObjectWallet,
  type BoatWalletOwner,
  type DB,
} from "@sealant/db";
import { Effect, Option } from "effect";

import { HttpBoatApi, type BoatApi, type BoatDiscovery } from "./api.js";
import {
  BoatApiError,
  BoatOwnership,
  BoatSecret,
  type BoatResult,
  type BoatSandboxId,
} from "./config.js";

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
 * The account has no wallet to create in yet (no pin, a key not known to be an organization's): no
 * create is made, since what it made would belong to whichever wallet its owner has active. Only
 * creates wait for it; every other request goes out, about the object it names.
 */
const walletUnresolved = (operation: string) =>
  new BoatApiError(operation, null, "account_wallet_unresolved");
/**
 * Boat has the object in none of the wallets the key can bill (for a key that cannot list them: not
 * in the one it bills). sealant recorded that, and asks about it no more. Not a 404: nothing reads
 * this as the object being gone.
 */
const objectUnreachable = (operation: string) =>
  new BoatApiError(operation, null, "object_unreachable");
/**
 * The object's wallet is not known, Boat did not find it where the request looked, and where else
 * it is could not be read (Boat did not answer, or not every wallet did). Only this object waits;
 * the next request about it looks again. Not a 404.
 */
const objectUnlocated = (operation: string) =>
  new BoatApiError(operation, null, "object_unlocated");

/** Where an object of unknown wallet is found: one wallet's id, nowhere, or not known. */
type Probe = "found" | "absent" | "unanswered";
const probeOf = (result: BoatResult<unknown>): Probe =>
  result.ok ? "found" : result.error.status === 404 ? "absent" : "unanswered";

/**
 * What a client asks about each request: which wallet the object it names is in, and how to open
 * the key in a wallet. A stored account's router reads its rows; the install's own key's reads
 * `boat_install`'s and the install's rows; a build's names only that build's image.
 */
export interface BoatObjectRouter {
  /** The client on the key's current revision that names `wallet` (null: none). */
  readonly clientIn: (wallet: string | null, fresh: boolean) => Promise<BoatResult<BoatApi>>;
  /** The wallet new objects are made in; read fresh. */
  readonly createWallet: () => Promise<BoatCreateWallet>;
  readonly objectOf: (ref: BoatObjectRef) => Promise<BoatObjectWallet>;
  readonly record: (
    ref: BoatObjectRef,
    found: { readonly wallet: string | null } | "unreachable",
  ) => Promise<void>;
}

/** Discovery's answer when Boat could not be asked or did not answer. */
const discoveryUnavailable = (error: BoatApiError): BoatDiscovery => ({
  kind: "unknown",
  reason: "inventory-unavailable",
  error,
});
/** Discovery as a result: an inventory Boat did not give is a failure, anything else an answer. */
const discoveryResult = (found: BoatDiscovery): BoatResult<BoatDiscovery> =>
  found.kind === "unknown" && found.reason === "inventory-unavailable"
    ? { ok: false, error: found.error }
    : { ok: true, value: found };

const refKey = (ref: BoatObjectRef) => JSON.stringify(ref);

/**
 * An account's client: every request names the wallet of the object it is about. A create names the
 * wallet the account makes things in now (its pin, or an organization key's only wallet). A request
 * about something sealant made names the wallet recorded for it; one made before sealant recorded
 * wallets goes out as it did then, naming none, and if Boat does not find it there, it is looked for
 * under every wallet the key can bill: found in one, that is recorded and the request made there;
 * found in none, it is recorded unreachable (`object_unreachable`), never gone; the wallets not
 * readable or not all answering, the request fails for this object only (`object_unlocated`).
 * Boat refusing the key (401, 403) may mean it was rotated a moment ago: the key is read again and
 * the request made once more if that opened another client. Every request here is safe to repeat.
 */
export class StoredAccountApi implements BoatApi {
  readonly #router: BoatObjectRouter;
  /** Known and unreachable objects, which never move again. */
  readonly #settled = new Map<string, BoatObjectWallet>();
  /**
   * Objects of unknown wallet whose delete, by sealant, Boat accepted with no wallet named: a
   * later miss is that delete done, whichever wallet is active by then.
   */
  readonly #deletedUnnamed = new Set<string>();
  constructor(router: BoatObjectRouter) {
    this.#router = router;
  }
  #open(operation: string, wallet: string | null, fresh: boolean) {
    return this.#router
      .clientIn(wallet, fresh)
      .catch((): BoatResult<BoatApi> => ({ ok: false, error: keyUnavailable(operation) }));
  }
  async #in<A>(
    operation: string,
    wallet: string | null,
    call: (api: BoatApi) => Promise<BoatResult<A>>,
    fresh = false,
  ): Promise<BoatResult<A>> {
    const api = await this.#open(operation, wallet, fresh);
    if (!api.ok) return { ok: false, error: api.error };
    const answered = await call(api.value);
    const status = answered.ok ? undefined : answered.error.status;
    if (status !== 401 && status !== 403) return answered;
    const again = await this.#open(operation, wallet, true);
    return again.ok && again.value !== api.value ? call(again.value) : answered;
  }
  async #where(ref: BoatObjectRef): Promise<BoatObjectWallet> {
    const key = refKey(ref);
    const settled = this.#settled.get(key);
    if (settled !== undefined) return settled;
    const found = await this.#router.objectOf(ref);
    if (found.kind === "known" || found.kind === "unreachable") this.#settled.set(key, found);
    return found;
  }
  async #record(ref: BoatObjectRef, found: { readonly wallet: string | null } | "unreachable") {
    await this.#router.record(ref, found);
    this.#settled.set(
      refKey(ref),
      found === "unreachable" ? { kind: "unreachable" } : { kind: "known", wallet: found.wallet },
    );
  }
  /**
   * Where an object Boat did not find without a wallet named is: the key's wallets, each asked with
   * `probe`. Without `account.read` there is no list, and the miss in the wallet it bills is all
   * there is: the object is unreachable, as the released sealant would have read it as gone.
   */
  async #locate(
    operation: string,
    ref: BoatObjectRef,
    probe: (api: BoatApi) => Promise<Probe>,
    /** Whether finding it nowhere is recorded (`unreachable`), or left as the released answer. */
    nowhere: "unreachable" | "released",
  ): Promise<{ readonly wallet: string | null } | BoatApiError | "released"> {
    const released = await this.#open(operation, null, false);
    if (!released.ok) return objectUnlocated(operation);
    const listed = await released.value.orgs?.().catch(() => undefined);
    if (listed === undefined) return objectUnlocated(operation);
    if (!listed.ok) {
      if (listed.error.status !== 403) return objectUnlocated(operation);
      if (nowhere === "released") return "released";
      await this.#record(ref, "unreachable");
      return objectUnreachable(operation);
    }
    const wallets = listed.value.map((org) => (org.type === "personal" ? "personal" : org.id));
    const seen = await Promise.all(
      wallets.map(async (wallet) => {
        const api = await this.#open(operation, wallet, false);
        const answer: Probe = api.ok
          ? await probe(api.value).catch((): Probe => "unanswered")
          : "unanswered";
        return [wallet, answer] as const;
      }),
    );
    const found = seen.filter(([, answer]) => answer === "found");
    if (found.length === 1 && found[0] !== undefined) {
      await this.#record(ref, { wallet: found[0][0] });
      return { wallet: found[0][0] };
    }
    if (found.length === 0 && seen.every(([, answer]) => answer === "absent")) {
      if (nowhere === "released") return "released";
      await this.#record(ref, "unreachable");
      return objectUnreachable(operation);
    }
    return objectUnlocated(operation);
  }
  /** A request about one object, in the wallet it is in. */
  async #about<A>(
    operation: string,
    ref: BoatObjectRef,
    call: (api: BoatApi) => Promise<BoatResult<A>>,
    probe: (api: BoatApi) => Promise<Probe>,
    missed: (result: BoatResult<A>) => boolean = (result) =>
      !result.ok && result.error.status === 404,
    nowhere: "unreachable" | "released" = "unreachable",
  ): Promise<BoatResult<A>> {
    const where = await this.#where(ref).catch(() => undefined);
    if (where === undefined) return { ok: false, error: objectUnlocated(operation) };
    if (where.kind === "unreachable") return { ok: false, error: objectUnreachable(operation) };
    if (where.kind === "known") return this.#in(operation, where.wallet, call);
    if (where.kind === "unrecorded") {
      const current = await this.#router.createWallet().catch(() => undefined);
      return this.#in(operation, current?.kind === "known" ? current.wallet : null, call);
    }
    const answered = await this.#in(operation, null, call);
    if (!missed(answered)) {
      if (answered.ok && (operation === "deleteSandbox" || operation === "deleteSnapshot"))
        this.#deletedUnnamed.add(refKey(ref));
      return answered;
    }
    // A miss after Boat accepted sealant's own delete of it (the read that confirms the delete):
    // the delete is done. Any other answer proves nothing once the owner switches wallets.
    if (this.#deletedUnnamed.has(refKey(ref))) return answered;
    const located = await this.#locate(operation, ref, probe, nowhere).catch(() =>
      objectUnlocated(operation),
    );
    if (located === "released") return answered;
    if (located instanceof BoatApiError) return { ok: false, error: located };
    return this.#in(operation, located.wallet, call);
  }
  #vm<A>(operation: string, id: BoatSandboxId, call: (api: BoatApi) => Promise<BoatResult<A>>) {
    return this.#about(operation, { sandbox: id }, call, async (api) => probeOf(await api.get(id)));
  }
  /**
   * A create names the wallet its run, or its image build, was recorded in when it was reserved: a
   * replay of one made before sealant recorded wallets names none, as it did then. Anything else
   * names the wallet the account makes things in now, read fresh.
   */
  async create(...args: Parameters<BoatApi["create"]>) {
    const [input] = args;
    const call = (api: BoatApi) => api.create(...args);
    const ref: BoatObjectRef | undefined =
      "ownership" in input
        ? { run: input.ownership.runId }
        : "buildOwnership" in input
          ? { publication: input.buildOwnership.reservation.publicationId }
          : undefined;
    const where: BoatObjectWallet | undefined =
      ref === undefined ? { kind: "unrecorded" } : await this.#where(ref).catch(() => undefined);
    if (where === undefined) return { ok: false, error: objectUnlocated("create") } as const;
    if (where.kind === "unreachable")
      return { ok: false, error: objectUnreachable("create") } as const;
    if (where.kind === "known") return this.#in("create", where.wallet, call, true);
    if (where.kind === "unknown") return this.#in("create", null, call, true);
    const wallet = await this.#router.createWallet().catch(() => undefined);
    if (wallet === undefined) return { ok: false, error: keyUnavailable("create") } as const;
    if (wallet.kind === "unresolved")
      return { ok: false, error: walletUnresolved("create") } as const;
    return this.#in("create", wallet.wallet, call, true);
  }
  async discover(...args: Parameters<BoatApi["discover"]>): Promise<BoatDiscovery> {
    const [ownership] = args;
    const ref: BoatObjectRef =
      ownership instanceof BoatOwnership
        ? { run: ownership.runId }
        : { publication: ownership.reservation.publicationId };
    const answered = await this.#about(
      "discover",
      ref,
      async (api) => discoveryResult(await api.discover(...args)),
      async (api) => {
        const found = await api.discover(...args);
        return found.kind === "found" || found.kind === "conflict"
          ? "found"
          : found.reason === "no-positive-evidence"
            ? "absent"
            : "unanswered";
      },
      // Discovery never reads a miss as absence; only its lack of evidence sends it looking, and
      // found nowhere, its released answer stands (a create is then replayed where it was made).
      (result) => result.ok && result.value.kind === "unknown",
      "released",
    );
    return answered.ok ? answered.value : discoveryUnavailable(answered.error);
  }
  get(...args: Parameters<BoatApi["get"]>) {
    return this.#vm("get", args[0], (api) => api.get(...args));
  }
  execute(...args: Parameters<BoatApi["execute"]>) {
    return this.#vm("execute", args[0], (api) => api.execute(...args));
  }
  writeFile(...args: Parameters<BoatApi["writeFile"]>) {
    return this.#vm("writeFile", args[0], (api) => api.writeFile(...args));
  }
  uploadFile(...args: Parameters<BoatApi["uploadFile"]>) {
    return this.#vm("uploadFile", args[0], (api) => api.uploadFile(...args));
  }
  hostControl(...args: Parameters<BoatApi["hostControl"]>) {
    return this.#vm("hostControl", args[0], (api) => api.hostControl(...args));
  }
  stop(...args: Parameters<BoatApi["stop"]>) {
    return this.#vm("stop", args[0], (api) => api.stop(...args));
  }
  resume(...args: Parameters<BoatApi["resume"]>) {
    return this.#vm("resume", args[0], (api) => api.resume(...args));
  }
  deleteSandbox(...args: Parameters<BoatApi["deleteSandbox"]>) {
    return this.#vm("deleteSandbox", args[0], (api) => api.deleteSandbox(...args));
  }
  getDeletion(...args: Parameters<BoatApi["getDeletion"]>) {
    const [id] = args;
    return this.#about(
      "getDeletion",
      { deletion: id },
      (api) => api.getDeletion(...args),
      async (api) => probeOf(await api.getDeletion(id)),
    );
  }
  /** A save is made in the wallet of the VM it saves, where the image then is. */
  saveSnapshot(...args: Parameters<BoatApi["saveSnapshot"]>) {
    return this.#vm("saveSnapshot", args[0], (api) => api.saveSnapshot(...args));
  }
  getSnapshot(...args: Parameters<BoatApi["getSnapshot"]>) {
    const [name] = args;
    return this.#about(
      "getSnapshot",
      { snapshot: name },
      (api) => api.getSnapshot(...args),
      async (api) => probeOf(await api.getSnapshot(name)),
    );
  }
  deleteSnapshot(...args: Parameters<BoatApi["deleteSnapshot"]>) {
    const [name] = args;
    return this.#about(
      "deleteSnapshot",
      { snapshot: name },
      (api) => api.deleteSnapshot(...args),
      async (api) => probeOf(await api.getSnapshot(name)),
    );
  }
}

/**
 * A client that names one wallet on every request, whatever the account names: what removes or
 * verifies something recorded in that wallet. Only a rotated key is read again.
 */
class FixedWalletApi extends StoredAccountApi {
  constructor(open: (fresh: boolean) => Promise<BoatResult<BoatApi>>, wallet: string | null) {
    super({
      clientIn: (_wallet, fresh) => open(fresh),
      createWallet: () => Promise.resolve({ kind: "known", wallet }),
      objectOf: () => Promise.resolve({ kind: "known", wallet }),
      record: () => Promise.resolve(),
    });
  }
}

/** The router of everything one build makes: it is all in the wallet its image is recorded in. */
const buildRouter = (router: BoatObjectRouter, publicationId: string): BoatObjectRouter => ({
  clientIn: router.clientIn,
  createWallet: async () => {
    const where = await router.objectOf({ publication: publicationId });
    return where.kind === "known" ? where : { kind: "unresolved" };
  },
  objectOf: () => router.objectOf({ publication: publicationId }),
  record: (_ref, found) => router.record({ publication: publicationId }, found),
});

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
 * again when the account's key revision changes (a rotation, or a change of the organization it
 * bills). No call here reaches Boat.
 */
export class BoatAccountDirectory {
  readonly #options: BoatAccountDirectoryOptions;
  readonly #providers = new Map<string, BoatAccountProvider>();
  /** Per account: its key at the revision last read, and a client per wallet named. */
  readonly #clients = new Map<
    string,
    {
      readonly revision: number;
      readonly credential: BoatSecret;
      readonly apis: Map<string, BoatApi>;
      checkedAt: number;
    }
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
   * A client for the account that names `organization` on every request (`X-Boat-Org`: an
   * organization's id or name, or `personal`), whatever the account names: what removes something
   * sealant found in that wallet. A rotated key is read again.
   */
  walletApi(accountId: string, organization: string | null): BoatApi {
    return new FixedWalletApi(
      (fresh) => this.#clientIn(accountId, organization, fresh),
      organization,
    );
  }

  /**
   * A client for everything one image build of the account makes: it names the wallet the image is
   * recorded in, and, for a build made before sealant recorded wallets, finds and records it.
   */
  buildApi(accountId: string, publicationId: string): BoatApi {
    return new StoredAccountApi(buildRouter(this.#router(accountId), publicationId));
  }

  /** Accounts the worker resolves: no pin and a personal or unobserved key, or unknown objects. */
  listUnresolved(): Promise<readonly BoatAccountRecord[]> {
    return this.#run(Effect.flatMap(BoatAccountRepo, (repo) => repo.listUnresolved()));
  }

  /** Forgets the account's client: its pin changed, and the next call opens one that names it. */
  forget(accountId: string): void {
    this.#clients.delete(accountId);
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
      api: new StoredAccountApi(this.#router(accountId)),
    };
    this.#providers.set(accountId, provider);
    return provider;
  }

  /** The account's router: its rows say where each object is. */
  #router(accountId: string): BoatObjectRouter {
    const owner: BoatWalletOwner = { accountId };
    return {
      clientIn: (wallet, fresh) => this.#clientIn(accountId, wallet, fresh),
      createWallet: async () => {
        const account = await this.account(accountId);
        return account === undefined
          ? { kind: "unresolved" }
          : createBoatWalletOf(account.organization, account.keyKind);
      },
      objectOf: (ref) =>
        this.#run(Effect.flatMap(BoatAccountRepo, (repo) => repo.objectWallet(owner, ref))),
      record: (ref, found) =>
        this.#run(
          Effect.flatMap(BoatAccountRepo, (repo) => repo.recordObjectWallet(owner, ref, found)),
        ),
    };
  }

  /**
   * The account's client on its current key that names `wallet` (null: none), opened again only
   * when the key was rotated. `fresh`: the revision is read now, whenever it was last read (Boat
   * refused the cached key).
   */
  async #clientIn(
    accountId: string,
    wallet: string | null,
    fresh: boolean,
  ): Promise<BoatResult<BoatApi>> {
    const now = Date.now();
    const cached = this.#clients.get(accountId);
    const every = this.#options.revisionCheckMs ?? 10_000;
    const named = (key: NonNullable<typeof cached>): BoatResult<BoatApi> => {
      const known = key.apis.get(wallet ?? "");
      if (known !== undefined) return { ok: true, value: known };
      const api = (this.#options.clientFor ?? httpBoatClientFactory)(
        key.credential,
        wallet === null ? undefined : { organization: wallet },
      );
      if (api.ok) key.apis.set(wallet ?? "", api.value);
      return api;
    };
    if (!fresh && cached !== undefined && now - cached.checkedAt < every) return named(cached);
    const revision = await this.#run(
      Effect.flatMap(BoatAccountRepo, (repo) => repo.keyRevision(accountId)),
    );
    if (revision === undefined) {
      this.#clients.delete(accountId);
      return { ok: false, error: keyUnavailable("credential") };
    }
    if (cached !== undefined && cached.revision === revision) {
      cached.checkedAt = now;
      return named(cached);
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
    const key = {
      revision: sealed.keyRevision,
      credential: credential.value,
      apis: new Map<string, BoatApi>(),
      checkedAt: now,
    };
    this.#clients.set(accountId, key);
    return named(key);
  }
}

/**
 * The install's own key's client: a create names the wallet `boat_install` holds for it
 * (`SEALANT_BOAT_ORGANIZATION` once applied, or what sealant observed when it pinned the key; none for
 * an organization's key); every other request names the wallet of the object it is about, as the
 * install's rows record it (`StoredAccountApi`).
 */
export const installBoatApi = (options: {
  readonly db: DB;
  readonly credential: BoatSecret;
  /** The install's own deployment: whose images are the install's. */
  readonly deploymentId: string;
  readonly clientFor?: BoatClientFactory;
}): BoatApi => new StoredAccountApi(installRouter(options));

/** A client for everything one image build of the install's own key makes (`buildApi`). */
export const installBuildApi = (
  options: Parameters<typeof installBoatApi>[0],
  publicationId: string,
): BoatApi => new StoredAccountApi(buildRouter(installRouter(options), publicationId));

const installRouter = (options: Parameters<typeof installBoatApi>[0]): BoatObjectRouter => {
  const apis = new Map<string, BoatApi>();
  const owner: BoatWalletOwner = { install: { deploymentId: options.deploymentId } };
  const repo = <A, E>(effect: Effect.Effect<A, E, BoatAccountRepo>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(BoatAccountRepoLive),
        Effect.provideService(SealantDB, options.db),
      ),
    );
  return {
    clientIn: (wallet) => {
      const known = apis.get(wallet ?? "");
      if (known !== undefined) return Promise.resolve({ ok: true, value: known });
      const api = (options.clientFor ?? httpBoatClientFactory)(
        options.credential,
        wallet === null ? undefined : { organization: wallet },
      );
      if (api.ok) apis.set(wallet ?? "", api.value);
      return Promise.resolve(api);
    },
    createWallet: async () => {
      const stored = await repo(Effect.flatMap(BoatAccountRepo, (each) => each.installWallet()));
      return createBoatWalletOf(stored?.organization ?? null, stored?.keyKind ?? null);
    },
    objectOf: (ref) =>
      repo(Effect.flatMap(BoatAccountRepo, (each) => each.objectWallet(owner, ref))),
    record: (ref, found) =>
      repo(Effect.flatMap(BoatAccountRepo, (each) => each.recordObjectWallet(owner, ref, found))),
  };
};

/** The install's own key's client that names `organization` (null: none), whatever it names. */
export const installWalletApi = (options: {
  readonly credential: BoatSecret;
  readonly clientFor?: BoatClientFactory;
  readonly organization: string | null;
}): BoatResult<BoatApi> => {
  const opened = (options.clientFor ?? httpBoatClientFactory)(
    options.credential,
    options.organization === null ? undefined : { organization: options.organization },
  );
  return opened.ok
    ? { ok: true, value: new FixedWalletApi(() => Promise.resolve(opened), options.organization) }
    : opened;
};
