/**
 * `Sealant` — the public client and the import users reach for.
 *
 *   import { Sealant, opencode } from "@sealant/sdk"
 *   const sealant = new Sealant({ baseUrl: "http://localhost:8080" })
 *
 * This is the plain-Promise facade over the Effect core: an app `Layer` built once in the
 * constructor providing the wire client derived from `@sealant/api-contracts`. Everything is a plain
 * HTTP call to `baseUrl`. Operations whose endpoints have not landed yet stay TYPED against the
 * stable surface and reject with `SealantNotImplementedError` so callers can compile and wire
 * against the final shape today.
 */
import type {
  ConnectedAccountSummary,
  WorkspaceCreateState as WireWorkspaceCreateState,
} from "@sealant/api-contracts";

import {
  archiveConnectedAccountOp,
  archiveSshKeyOp,
  cancelWorkspaceCreateOp,
  createAccessTokenOp,
  createConnectedAccountOp,
  createSshKeyOp,
  createWorkspaceOp,
  ensureUserOp,
  getRunOp,
  getSetupStateOp,
  getUserOp,
  bindUserPersonOp,
  getWorkspaceCreateOp,
  getWorkspaceOp,
  inferenceRespondOp,
  inspectWorkspaceImageOp,
  listConnectedAccountsOp,
  listSshKeysOp,
  listWorkspacesOp,
} from "./effect/operations.js";
import { runHarness, startHarness } from "./effect/run-harness.js";
import { makeSdkRuntime, type SdkRuntime } from "./effect/runtime.js";
import { SealantError } from "./errors.js";
import type { SdkContext } from "./facade/context.js";
import { makeRun } from "./facade/run.js";
import {
  makeWorkspace,
  registerHarnessExecutors,
  toRuntimeInfo,
  toWorkspaceImage,
} from "./facade/workspace.js";
import { buildCreateWorkspaceRequest } from "./internal/blueprint.js";
import { resolveInternalConfig } from "./internal/config.js";
import { parseTtlSeconds } from "./internal/duration.js";
import { readFeatures } from "./internal/features.js";
import { imageSpecKey } from "./internal/image-key.js";
import { buildInferenceRespondRequest, mapInferenceResponse } from "./internal/inference.js";
import { requireSshUser } from "./internal/process-user.js";
import { mapSshKey, mapWorkspaceSshInfo } from "./internal/ssh.js";
import type {
  AccessTokensNamespace,
  ConnectedAccount,
  ConnectedAccountsNamespace,
  CreateOptions,
  InferenceNamespace,
  ListOptions,
  Run,
  SealantFeatures,
  SshKeysNamespace,
  Workspace,
  WorkspaceCreateState,
  WorkspaceImageInspection,
  WorkspaceSshNamespace,
  SealantConfig,
  UsersNamespace,
} from "./types.js";

/** An idempotent create's state as the SDK reports it (an unknown wire state fails closed). */
const toCreateState = (wire: WireWorkspaceCreateState): WorkspaceCreateState => ({
  idempotencyKey: wire.idempotencyKey,
  state: wire.state,
  ...(wire.workspaceId === undefined ? {} : { workspaceId: wire.workspaceId }),
  ...(wire.runId === undefined ? {} : { runId: wire.runId }),
  ...(wire.launchId === undefined ? {} : { launchId: wire.launchId }),
});

const mapConnectedAccount = (wire: ConnectedAccountSummary): ConnectedAccount => ({
  connectedAccountId: wire.connectedAccountId,
  ownerUserId: wire.ownerUserId,
  provider: wire.provider,
  name: wire.name,
  kind: wire.kind,
  status: wire.status,
  metadata: wire.metadata,
  connectedAt: wire.connectedAt,
  updatedAt: wire.updatedAt,
  lastUsedAt: wire.lastUsedAt,
  lastSyncedAt: wire.lastSyncedAt,
  credential: wire.credential,
});

// Wire the run-execution implementations into the Workspace facade (the injection point exists to
// break the workspace <-> run-harness import cycle; the client is the composition root).
registerHarnessExecutors({ run: runHarness, start: startHarness });

export class Sealant {
  readonly #config: SealantConfig;
  readonly #runtime: SdkRuntime;
  readonly #ctx: SdkContext;

  constructor(config: SealantConfig) {
    if (config.baseUrl.trim().length === 0) {
      throw new SealantError("Sealant requires a non-empty `baseUrl`.", { code: "invalid_config" });
    }
    const internalConfig = resolveInternalConfig(config);
    this.#config = config;
    this.#runtime = makeSdkRuntime(internalConfig);
    this.#ctx = { runtime: this.#runtime, config: internalConfig };
  }

  /** The configured control-plane base URL. */
  get baseUrl(): string {
    return this.#config.baseUrl;
  }

  /**
   * What the control plane can do that an older one cannot (see {@link SealantFeatures}), read
   * once per client and kept five minutes. Rejects when the control plane could not be asked.
   */
  features(): Promise<SealantFeatures> {
    return readFeatures(this.#ctx);
  }

  /** Workspace lifecycle: create, fetch, and list live environments. */
  readonly workspaces = {
    create: async (options: CreateOptions): Promise<Workspace> => {
      if (options.sshAsOwner === true) {
        await requireSshUser(this.#ctx);
      }
      const { payload } = buildCreateWorkspaceRequest(options, this.#ctx.config);
      const created = await this.#runtime.run(createWorkspaceOp(payload));
      const workspace = makeWorkspace(this.#ctx, {
        id: created.workspaceId,
        name: created.name,
        status: created.status,
        harness: options.harness,
        // A replayed create did not start this launch here: a readiness timeout on it is not an
        // abandoned launch this handle owns.
        created: created.replayed !== true,
        ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
        ...(options.imageBuildTimeoutMs === undefined
          ? {}
          : { imageBuildTimeoutMs: options.imageBuildTimeoutMs }),
        launch: {
          replayed: created.replayed === true,
          ...(created.runId === undefined ? {} : { runId: created.runId }),
          ...(created.launchId === undefined ? {} : { launchId: created.launchId }),
          ...(created.runtime === undefined ? {} : { runtime: toRuntimeInfo(created.runtime) }),
        },
      });
      if (options.wait === false) {
        return workspace;
      }
      // Pump provisioning events to onEvent (best-effort) while we wait for ready. Never let an
      // event-stream hiccup fail create().
      if (options.onEvent !== undefined) {
        const onEvent = options.onEvent;
        void (async () => {
          try {
            for await (const event of workspace.events()) {
              onEvent(event);
            }
          } catch {
            // best-effort observation only
          }
        })();
      }
      return workspace.ready();
    },

    get: async (id: string): Promise<Workspace> => {
      const details = await this.#runtime.run(
        getWorkspaceOp(id, this.#ctx.config.hostLocal.ownerUserId),
      );
      return makeWorkspace(this.#ctx, {
        id: details.workspaceId,
        name: details.name,
        status: details.status,
      });
    },

    /**
     * A key to keep the per-person capability of `create(options)`'s image under, computed here
     * from the spec alone, with no call. It is the same for creates whose image-shaping parts
     * (harness, tooling, customization, lifecycle, access, target) are the same, whatever their
     * repository, credentials or homes. It keys the capability, not the image itself. Keep what a
     * launch's `launch.image` told you under it, and call `inspectImage` only for a key you have not
     * seen.
     */
    imageKey: (options: CreateOptions): string =>
      imageSpecKey(buildCreateWorkspaceRequest(options, this.#ctx.config).payload.spec),

    /**
     * What `create(options)` would build, read before the create: the spec is planned exactly as
     * the build plans it, and the latest image published for that plan answers with its
     * per-person capability (Mend ADR 0016 chooses a layout with it). Nothing is created, built or
     * reserved. A spec whose dotfiles or source the control plane resolves at create may plan
     * differently; then nothing is found and the capability is `unknown`.
     */
    inspectImage: async (options: CreateOptions): Promise<WorkspaceImageInspection> => {
      const { payload } = buildCreateWorkspaceRequest(options, this.#ctx.config);
      const answered = await this.#runtime.run(
        inspectWorkspaceImageOp({
          ownerUserId: payload.ownerUserId,
          registryId: payload.registryId,
          spec: payload.spec,
        }),
      );
      return {
        imageKey: imageSpecKey(payload.spec),
        planHash: answered.planHash,
        ...(answered.publishedImage === undefined
          ? {}
          : { image: toWorkspaceImage(answered.publishedImage) }),
        personLayout: {
          ...answered.personLayout,
          missing: [...answered.personLayout.missing],
          unknown: [...answered.personLayout.unknown],
        },
      };
    },

    /**
     * The owner's workspace a `create({ idempotencyKey })` made, or `null`: what a caller that
     * lost a create's answer uses to find the executor it started.
     */
    findByIdempotencyKey: async (idempotencyKey: string): Promise<Workspace | null> => {
      const response = await this.#runtime.run(
        listWorkspacesOp({
          ownerUserId: this.#ctx.config.hostLocal.ownerUserId,
          idempotencyKey,
        }),
      );
      const item = response.items[0];
      return item === undefined
        ? null
        : makeWorkspace(this.#ctx, { id: item.workspaceId, name: item.name, status: item.status });
    },

    /**
     * What became of the create with this idempotency key: `pending` (started, not committed),
     * `found` (committed: `workspaceId`, `runId`, `launchId`), `cancelled`, or `none` (nothing has
     * reached the control plane — as of now only; use `cancelCreate` for an answer that stays
     * true).
     */
    createState: async (idempotencyKey: string): Promise<WorkspaceCreateState> =>
      toCreateState(
        await this.#runtime.run(
          getWorkspaceCreateOp(idempotencyKey, this.#ctx.config.hostLocal.ownerUserId),
        ),
      ),

    /**
     * Make sure the create with this idempotency key never launches: a pending or unknown key is
     * cancelled for good (a delayed original request with it is refused, `create-cancelled`). A
     * create that already committed answers `found` — stop that workspace instead.
     */
    cancelCreate: async (idempotencyKey: string): Promise<WorkspaceCreateState> =>
      toCreateState(
        await this.#runtime.run(
          cancelWorkspaceCreateOp(idempotencyKey, {
            ownerUserId: this.#ctx.config.hostLocal.ownerUserId,
          }),
        ),
      ),

    list: async (options?: ListOptions): Promise<readonly Workspace[]> => {
      const response = await this.#runtime.run(
        listWorkspacesOp({
          ownerUserId: this.#ctx.config.hostLocal.ownerUserId,
          ...(options?.status === undefined ? {} : { status: options.status }),
          ...(options?.limit === undefined ? {} : { limit: String(options.limit) }),
        }),
      );
      return response.items.map((item) =>
        makeWorkspace(this.#ctx, {
          id: item.workspaceId,
          name: item.name,
          status: item.status,
        }),
      );
    },
  };

  /**
   * Inference on connected accounts — server-side via the official agent SDKs, never raw model-API
   * calls. Tool calls park server-side; execute them here and `respond()` with the results.
   */
  readonly inference: InferenceNamespace = {
    respond: async (options) => {
      const payload = buildInferenceRespondRequest(options, this.#ctx.config.hostLocal.ownerUserId);
      const wire = await this.#runtime.run(inferenceRespondOp(payload));
      return mapInferenceResponse(wire);
    },
  };

  /**
   * Scoped bearer tokens for the session surface — `session:read` / `session:input` /
   * `workspace:exec`. The returned secret is shown once; hand it to a client as its `apiKey` and
   * the session endpoints enforce exactly those scopes (a read-stream token can stream but is
   * rejected for input and exec).
   */
  /** Identity rows for products that own their own login (one client per user afterwards). */
  readonly users: UsersNamespace = {
    ensure: async (options) => {
      const wire = await this.#runtime.run(
        ensureUserOp({
          email: options.email,
          name: options.name,
          ...(options.userId === undefined ? {} : { userId: options.userId }),
        }),
      );
      return {
        userId: wire.userId,
        email: wire.email,
        name: wire.name,
        createdAt: wire.createdAt,
        created: wire.created,
      };
    },
    get: async (userId) => {
      const wire = await this.#runtime.run(getUserOp(userId));
      return { userId: wire.userId, email: wire.email, name: wire.name, createdAt: wire.createdAt };
    },
    bindPerson: async (userId, person) => {
      const wire = await this.#runtime.run(
        bindUserPersonOp(userId, { id: person.id, uid: person.uid, home: person.home }),
      );
      return { userId: wire.userId, person: wire.person, created: wire.created };
    },
  };

  /** This client's owner's Claude / Codex / GitHub accounts. Secrets go in; none come out. */
  readonly connectedAccounts: ConnectedAccountsNamespace = {
    list: async () => {
      const wire = await this.#runtime.run(
        listConnectedAccountsOp(this.#ctx.config.hostLocal.ownerUserId),
      );
      return wire.items.map(mapConnectedAccount);
    },
    connect: async (options) => {
      const wire = await this.#runtime.run(
        createConnectedAccountOp({
          ownerUserId: this.#ctx.config.hostLocal.ownerUserId,
          provider: options.provider,
          secret: options.secret,
          ...(options.name === undefined ? {} : { name: options.name }),
        }),
      );
      return mapConnectedAccount(wire);
    },
    disconnect: async (connectedAccountId) => {
      const wire = await this.#runtime.run(
        archiveConnectedAccountOp(connectedAccountId, this.#ctx.config.hostLocal.ownerUserId),
      );
      return mapConnectedAccount(wire);
    },
  };

  /**
   * Where workspace SSH connects for this deployment — how an editor (VS Code Remote-SSH) or
   * plain `ssh` reaches a workspace. Destination: `<usernamePrefix>-<workspaceId>@<host>:<port>`;
   * the gateway authorizes each connection from the offered key's owning account.
   */
  readonly workspaceSsh: WorkspaceSshNamespace = {
    info: async () => {
      const wire = await this.#runtime.run(getSetupStateOp());
      return mapWorkspaceSshInfo(wire);
    },
  };

  /**
   * The owner's SSH public keys — what the workspace SSH gateway resolves a connection to.
   * `ensure` is idempotent: re-offering the same key returns the existing row.
   */
  readonly sshKeys: SshKeysNamespace = {
    ensure: async (options) =>
      mapSshKey(
        await this.#runtime.run(
          createSshKeyOp({
            ownerUserId: this.#ctx.config.hostLocal.ownerUserId,
            publicKey: options.publicKey,
            ...(options.name === undefined ? {} : { name: options.name }),
          }),
        ),
      ),
    list: async () => {
      const wire = await this.#runtime.run(listSshKeysOp(this.#ctx.config.hostLocal.ownerUserId));
      return wire.items.map(mapSshKey);
    },
    remove: async (sshKeyId) =>
      mapSshKey(
        await this.#runtime.run(archiveSshKeyOp(sshKeyId, this.#ctx.config.hostLocal.ownerUserId)),
      ),
  };

  readonly accessTokens: AccessTokensNamespace = {
    create: async (options) => {
      const wire = await this.#runtime.run(
        createAccessTokenOp({
          ownerUserId: this.#ctx.config.hostLocal.ownerUserId,
          scopes: [...options.scopes],
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
          ...(options.ttl === undefined ? {} : { ttlSeconds: parseTtlSeconds(options.ttl) }),
        }),
      );
      return {
        tokenId: wire.tokenId,
        token: wire.token,
        scopes: [...wire.scopes],
        ...(wire.workspaceId === undefined ? {} : { workspaceId: wire.workspaceId }),
        ...(wire.expiresAt === undefined ? {} : { expiresAt: wire.expiresAt }),
      };
    },
  };

  /** Runs by id — so a record can be replayed long after its workspace is gone. */
  readonly runs = {
    get: async (runId: string): Promise<Run> => {
      const wire = await this.#runtime.run(getRunOp(runId, this.#ctx.config.hostLocal.ownerUserId));
      return makeRun(this.#ctx, { wire });
    },
  };

  /** Release resources held by the client (the Effect runtime scope: DB pool, daemon connections). */
  async close(): Promise<void> {
    await this.#runtime.dispose();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
