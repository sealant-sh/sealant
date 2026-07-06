import {
  connectedAccountSummarySchema,
  createConnectedAccountRequestSchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  createSshKeyRequestSchema,
  listConnectedAccountsResponseSchema,
  listProfileCredentialBindingsResponseSchema,
  listProfilesResponseSchema,
  githubInstallationIdParamsSchema,
  githubInstallationRepositoriesQuerySchema,
  githubInstallationsQuerySchema,
  importGitHubInstallationRequestSchema,
  importGitHubInstallationResponseSchema,
  listGitHubInstallationRepositoriesResponseSchema,
  listGitHubInstallationsResponseSchema,
  listWorkspaceAttemptsQuerySchema,
  listWorkspaceAttemptsResponseSchema,
  listWorkspaceEventsQuerySchema,
  listWorkspaceEventsResponseSchema,
  listWorkspacesQuerySchema,
  listWorkspacesResponseSchema,
  listSshKeysResponseSchema,
  messageResponseSchema,
  renameWorkspaceRequestSchema,
  renameWorkspaceResponseSchema,
  listRunsQuerySchema,
  listRunsResponseSchema,
  resolvePackageQuerySchema,
  resolvePackageResponseSchema,
  runChangesResponseSchema,
  runEventParamsSchema,
  runEventSchema,
  runIdParamsSchema,
  runLossReportSchema,
  runSchema,
  runScrollbackQuerySchema,
  runScrollbackResponseSchema,
  runTimelineQuerySchema,
  runTimelineResponseSchema,
  workspaceDetailsSchema,
  workspaceIdParamsSchema,
  setupStateResponseSchema,
  sshKeyIdParamsSchema,
  sshKeySummarySchema,
  syncGitHubInstallationQuerySchema,
  syncGitHubInstallationResponseSchema,
} from "@sealant/validators";

const DEFAULT_CORE_API_URL = "http://localhost:4000";

interface JsonSchema<TOutput> {
  parse(input: unknown): TOutput;
}

type InferSchema<TSchema extends JsonSchema<unknown>> =
  TSchema extends JsonSchema<infer TOutput> ? TOutput : never;

export class CoreApiHttpError extends Error {
  public readonly status: number;
  public readonly url: string;

  public constructor(input: { message: string; status: number; url: string }) {
    super(input.message);
    this.name = "CoreApiHttpError";
    this.status = input.status;
    this.url = input.url;
  }
}

interface CoreApiRequestOptions<TOutput> {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly schema: JsonSchema<TOutput>;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  readonly headers?: HeadersInit;
}

export interface CreateCoreApiClientOptions {
  readonly baseUrl?: string;
  readonly fetchImplementation?: typeof fetch;
}

const normalizeBaseUrl = (input: string): string => {
  return input.endsWith("/") ? input : `${input}/`;
};

const getCoreApiBaseUrl = (): string => {
  // CORE_API_BASE_URL is the server-side runtime override (a prebuilt web image points it at the
  // api container); VITE_API_URL is baked into bundles at build time and must not shadow it.
  const configuredBaseUrl =
    process.env.CORE_API_BASE_URL ?? import.meta.env.VITE_API_URL ?? process.env.VITE_API_URL;

  if (typeof configuredBaseUrl === "string" && configuredBaseUrl.trim().length > 0) {
    return configuredBaseUrl;
  }

  return DEFAULT_CORE_API_URL;
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const parseWithSchema = <TOutput>(schema: JsonSchema<TOutput>, input: unknown): TOutput => {
  return schema.parse(input);
};

export interface CoreApiClient {
  readonly github: {
    importInstallation(
      input: InferSchema<typeof importGitHubInstallationRequestSchema>,
    ): Promise<InferSchema<typeof importGitHubInstallationResponseSchema>>;
    installations(
      input: InferSchema<typeof githubInstallationsQuerySchema>,
    ): Promise<InferSchema<typeof listGitHubInstallationsResponseSchema>>;
    installationRepositories(input: {
      readonly installationId: string;
      readonly userId: string;
      readonly search?: string;
    }): Promise<InferSchema<typeof listGitHubInstallationRepositoriesResponseSchema>>;
    syncInstallation(input: {
      readonly installationId: string;
      readonly userId: string;
    }): Promise<InferSchema<typeof syncGitHubInstallationResponseSchema>>;
  };
  readonly packages: {
    resolve(
      input: InferSchema<typeof resolvePackageQuerySchema>,
    ): Promise<InferSchema<typeof resolvePackageResponseSchema>>;
  };
  readonly workspaces: {
    create(
      input: InferSchema<typeof createWorkspaceRequestSchema>,
      options?: {
        readonly idempotencyKey?: string;
      },
    ): Promise<InferSchema<typeof createWorkspaceResponseSchema>>;
    list(
      input: InferSchema<typeof listWorkspacesQuerySchema>,
    ): Promise<InferSchema<typeof listWorkspacesResponseSchema>>;
    byId(
      input: InferSchema<typeof workspaceIdParamsSchema>,
    ): Promise<InferSchema<typeof workspaceDetailsSchema>>;
    attempts(input: {
      readonly workspaceId: string;
      readonly limit?: number;
    }): Promise<InferSchema<typeof listWorkspaceAttemptsResponseSchema>>;
    events(input: {
      readonly workspaceId: string;
      readonly limit?: number;
    }): Promise<InferSchema<typeof listWorkspaceEventsResponseSchema>>;
    rename(input: {
      readonly workspaceId: string;
      readonly name: string;
    }): Promise<InferSchema<typeof renameWorkspaceResponseSchema>>;
  };
  readonly runs: {
    list(input: {
      readonly ownerUserId: string;
      readonly workspaceId?: string;
      readonly status?: InferSchema<typeof runSchema>["status"];
      readonly limit?: number;
    }): Promise<InferSchema<typeof listRunsResponseSchema>>;
    byId(input: InferSchema<typeof runIdParamsSchema>): Promise<InferSchema<typeof runSchema>>;
    timeline(
      input: InferSchema<typeof runIdParamsSchema> & InferSchema<typeof runTimelineQuerySchema>,
    ): Promise<InferSchema<typeof runTimelineResponseSchema>>;
    event(
      input: InferSchema<typeof runEventParamsSchema>,
    ): Promise<InferSchema<typeof runEventSchema>>;
    scrollback(
      input: InferSchema<typeof runIdParamsSchema> & InferSchema<typeof runScrollbackQuerySchema>,
    ): Promise<InferSchema<typeof runScrollbackResponseSchema>>;
    loss(
      input: InferSchema<typeof runIdParamsSchema>,
    ): Promise<InferSchema<typeof runLossReportSchema>>;
    changes(
      input: InferSchema<typeof runIdParamsSchema>,
    ): Promise<InferSchema<typeof runChangesResponseSchema>>;
  };
  readonly sshKeys: {
    create(
      input: InferSchema<typeof createSshKeyRequestSchema>,
    ): Promise<InferSchema<typeof sshKeySummarySchema>>;
    list(input: {
      readonly ownerUserId: string;
    }): Promise<InferSchema<typeof listSshKeysResponseSchema>>;
    archive(input: {
      readonly sshKeyId: string;
      readonly ownerUserId: string;
    }): Promise<InferSchema<typeof sshKeySummarySchema>>;
  };
  readonly system: {
    setupState(): Promise<InferSchema<typeof setupStateResponseSchema>>;
  };
  readonly connectedAccounts: {
    create(
      input: InferSchema<typeof createConnectedAccountRequestSchema>,
    ): Promise<InferSchema<typeof connectedAccountSummarySchema>>;
    list(input: {
      readonly ownerUserId: string;
    }): Promise<InferSchema<typeof listConnectedAccountsResponseSchema>>;
    archive(input: {
      readonly connectedAccountId: string;
      readonly ownerUserId: string;
    }): Promise<InferSchema<typeof connectedAccountSummarySchema>>;
  };
  readonly profiles: {
    list(input: {
      readonly ownerUserId: string;
    }): Promise<InferSchema<typeof listProfilesResponseSchema>>;
    listCredentialBindings(input: {
      readonly profileId: string;
      readonly ownerUserId: string;
    }): Promise<InferSchema<typeof listProfileCredentialBindingsResponseSchema>>;
    setCredentialBinding(input: {
      readonly profileId: string;
      readonly ownerUserId: string;
      readonly provider: InferSchema<typeof createConnectedAccountRequestSchema>["provider"];
      readonly connectedAccountId: string | null;
    }): Promise<InferSchema<typeof listProfileCredentialBindingsResponseSchema>>;
  };
}

class CoreApiClientImpl implements CoreApiClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  public readonly workspaces: CoreApiClient["workspaces"];
  public readonly packages: CoreApiClient["packages"];
  public readonly github: CoreApiClient["github"];
  public readonly runs: CoreApiClient["runs"];
  public readonly sshKeys: CoreApiClient["sshKeys"];
  public readonly system: CoreApiClient["system"];
  public readonly connectedAccounts: CoreApiClient["connectedAccounts"];
  public readonly profiles: CoreApiClient["profiles"];

  public constructor(options: CreateCoreApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? getCoreApiBaseUrl());
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.workspaces = {
      create: (input, requestOptions) => this.createWorkspace(input, requestOptions),
      list: (input) => this.listWorkspaces(input),
      byId: (input) => this.getWorkspace(input),
      attempts: (input) => this.listWorkspaceAttempts(input),
      events: (input) => this.listWorkspaceEvents(input),
      rename: (input) => this.renameWorkspace(input),
    };
    this.packages = {
      resolve: (input) => this.resolvePackage(input),
    };
    this.github = {
      importInstallation: (input) => this.importGitHubInstallation(input),
      installations: (input) => this.listGitHubInstallations(input),
      installationRepositories: (input) => this.listGitHubInstallationRepositories(input),
      syncInstallation: (input) => this.syncGitHubInstallation(input),
    };
    this.runs = {
      list: (input) => this.listRuns(input),
      byId: (input) => this.getRun(input),
      timeline: (input) => this.getRunTimeline(input),
      event: (input) => this.getRunEvent(input),
      scrollback: (input) => this.getRunScrollback(input),
      loss: (input) => this.getRunLoss(input),
      changes: (input) => this.getRunChanges(input),
    };
    this.sshKeys = {
      create: (input) => this.createSshKey(input),
      list: (input) => this.listSshKeys(input),
      archive: (input) => this.archiveSshKey(input),
    };
    this.system = {
      setupState: () => this.getSetupState(),
    };
    this.connectedAccounts = {
      create: (input) => this.createConnectedAccount(input),
      list: (input) => this.listConnectedAccounts(input),
      archive: (input) => this.archiveConnectedAccount(input),
    };
    this.profiles = {
      list: (input) => this.listProfiles(input),
      listCredentialBindings: (input) => this.listProfileCredentialBindings(input),
      setCredentialBinding: (input) => this.setProfileCredentialBinding(input),
    };
  }

  private async getSetupState(): Promise<InferSchema<typeof setupStateResponseSchema>> {
    return this.requestJson({
      method: "GET",
      path: "/v1/system/setup-state",
      schema: setupStateResponseSchema,
    });
  }

  private async createConnectedAccount(
    input: InferSchema<typeof createConnectedAccountRequestSchema>,
  ): Promise<InferSchema<typeof connectedAccountSummarySchema>> {
    const payload = createConnectedAccountRequestSchema.parse(input);

    return this.requestJson({
      method: "POST",
      path: "/v1/connected-accounts",
      schema: connectedAccountSummarySchema,
      body: payload,
    });
  }

  private async listConnectedAccounts(input: {
    readonly ownerUserId: string;
  }): Promise<InferSchema<typeof listConnectedAccountsResponseSchema>> {
    return this.requestJson({
      method: "GET",
      path: "/v1/connected-accounts",
      schema: listConnectedAccountsResponseSchema,
      query: { ownerUserId: input.ownerUserId },
    });
  }

  private async archiveConnectedAccount(input: {
    readonly connectedAccountId: string;
    readonly ownerUserId: string;
  }): Promise<InferSchema<typeof connectedAccountSummarySchema>> {
    return this.requestJson({
      method: "DELETE",
      path: `/v1/connected-accounts/${encodeURIComponent(input.connectedAccountId)}`,
      schema: connectedAccountSummarySchema,
      query: { ownerUserId: input.ownerUserId },
    });
  }

  private async listProfiles(input: {
    readonly ownerUserId: string;
  }): Promise<InferSchema<typeof listProfilesResponseSchema>> {
    return this.requestJson({
      method: "GET",
      path: "/v1/profiles",
      schema: listProfilesResponseSchema,
      query: { ownerUserId: input.ownerUserId },
    });
  }

  private async listProfileCredentialBindings(input: {
    readonly profileId: string;
    readonly ownerUserId: string;
  }): Promise<InferSchema<typeof listProfileCredentialBindingsResponseSchema>> {
    return this.requestJson({
      method: "GET",
      path: `/v1/profiles/${encodeURIComponent(input.profileId)}/credential-bindings`,
      schema: listProfileCredentialBindingsResponseSchema,
      query: { ownerUserId: input.ownerUserId },
    });
  }

  private async setProfileCredentialBinding(input: {
    readonly profileId: string;
    readonly ownerUserId: string;
    readonly provider: InferSchema<typeof createConnectedAccountRequestSchema>["provider"];
    readonly connectedAccountId: string | null;
  }): Promise<InferSchema<typeof listProfileCredentialBindingsResponseSchema>> {
    return this.requestJson({
      method: "PUT",
      path: `/v1/profiles/${encodeURIComponent(input.profileId)}/credential-bindings`,
      schema: listProfileCredentialBindingsResponseSchema,
      body: {
        ownerUserId: input.ownerUserId,
        provider: input.provider,
        connectedAccountId: input.connectedAccountId,
      },
    });
  }

  private async listRuns(input: {
    readonly ownerUserId: string;
    readonly workspaceId?: string;
    readonly status?: InferSchema<typeof runSchema>["status"];
    readonly limit?: number;
  }): Promise<InferSchema<typeof listRunsResponseSchema>> {
    const query = listRunsQuerySchema.parse({
      workspaceId: input.workspaceId,
      status: input.status,
      limit: input.limit,
    });

    return this.requestJson({
      method: "GET",
      path: "/v1/runs",
      schema: listRunsResponseSchema,
      query: {
        ownerUserId: input.ownerUserId,
        workspaceId: query.workspaceId,
        status: query.status,
        limit: query.limit,
      },
    });
  }

  private async getRun(
    input: InferSchema<typeof runIdParamsSchema>,
  ): Promise<InferSchema<typeof runSchema>> {
    const params = runIdParamsSchema.parse(input);

    return this.requestJson({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(params.runId)}`,
      schema: runSchema,
    });
  }

  private async getRunTimeline(
    input: InferSchema<typeof runIdParamsSchema> & InferSchema<typeof runTimelineQuerySchema>,
  ): Promise<InferSchema<typeof runTimelineResponseSchema>> {
    const params = runIdParamsSchema.parse({ runId: input.runId });
    const query = runTimelineQuerySchema.parse({
      fromSequence: input.fromSequence,
      toSequence: input.toSequence,
      limit: input.limit,
      kinds: input.kinds,
    });

    return this.requestJson({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(params.runId)}/timeline`,
      schema: runTimelineResponseSchema,
      query: {
        fromSequence: query.fromSequence,
        toSequence: query.toSequence,
        limit: query.limit,
        // The wire carries kinds as a comma-separated list (see api-contracts runs.ts).
        kinds: query.kinds?.join(","),
      },
    });
  }

  private async getRunEvent(
    input: InferSchema<typeof runEventParamsSchema>,
  ): Promise<InferSchema<typeof runEventSchema>> {
    const params = runEventParamsSchema.parse(input);

    return this.requestJson({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(params.runId)}/events/${encodeURIComponent(params.sequence)}`,
      schema: runEventSchema,
    });
  }

  private async getRunScrollback(
    input: InferSchema<typeof runIdParamsSchema> & InferSchema<typeof runScrollbackQuerySchema>,
  ): Promise<InferSchema<typeof runScrollbackResponseSchema>> {
    const params = runIdParamsSchema.parse({ runId: input.runId });
    const query = runScrollbackQuerySchema.parse({
      processId: input.processId,
      stream: input.stream,
      atSequence: input.atSequence,
    });

    return this.requestJson({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(params.runId)}/scrollback`,
      schema: runScrollbackResponseSchema,
      query: {
        processId: query.processId,
        stream: query.stream,
        atSequence: query.atSequence,
      },
    });
  }

  private async getRunLoss(
    input: InferSchema<typeof runIdParamsSchema>,
  ): Promise<InferSchema<typeof runLossReportSchema>> {
    const params = runIdParamsSchema.parse(input);

    return this.requestJson({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(params.runId)}/loss`,
      schema: runLossReportSchema,
    });
  }

  private async getRunChanges(
    input: InferSchema<typeof runIdParamsSchema>,
  ): Promise<InferSchema<typeof runChangesResponseSchema>> {
    const params = runIdParamsSchema.parse(input);

    return this.requestJson({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(params.runId)}/changes`,
      schema: runChangesResponseSchema,
    });
  }

  private async createSshKey(
    input: InferSchema<typeof createSshKeyRequestSchema>,
  ): Promise<InferSchema<typeof sshKeySummarySchema>> {
    const payload = createSshKeyRequestSchema.parse(input);

    return this.requestJson({
      method: "POST",
      path: "/v1/ssh-keys",
      schema: sshKeySummarySchema,
      body: payload,
    });
  }

  private async listSshKeys(input: {
    readonly ownerUserId: string;
  }): Promise<InferSchema<typeof listSshKeysResponseSchema>> {
    return this.requestJson({
      method: "GET",
      path: "/v1/ssh-keys",
      schema: listSshKeysResponseSchema,
      query: { ownerUserId: input.ownerUserId },
    });
  }

  private async archiveSshKey(input: {
    readonly sshKeyId: string;
    readonly ownerUserId: string;
  }): Promise<InferSchema<typeof sshKeySummarySchema>> {
    const params = sshKeyIdParamsSchema.parse({ sshKeyId: input.sshKeyId });

    return this.requestJson({
      method: "DELETE",
      path: `/v1/ssh-keys/${encodeURIComponent(params.sshKeyId)}`,
      schema: sshKeySummarySchema,
      query: { ownerUserId: input.ownerUserId },
    });
  }

  private async importGitHubInstallation(
    input: InferSchema<typeof importGitHubInstallationRequestSchema>,
  ): Promise<InferSchema<typeof importGitHubInstallationResponseSchema>> {
    const payload = importGitHubInstallationRequestSchema.parse(input);

    return this.requestJson({
      method: "POST",
      path: "/v1/github/installations/import",
      schema: importGitHubInstallationResponseSchema,
      body: payload,
    });
  }

  private async listGitHubInstallations(
    input: InferSchema<typeof githubInstallationsQuerySchema>,
  ): Promise<InferSchema<typeof listGitHubInstallationsResponseSchema>> {
    const query = githubInstallationsQuerySchema.parse(input);

    return this.requestJson({
      method: "GET",
      path: "/v1/github/installations",
      schema: listGitHubInstallationsResponseSchema,
      query,
    });
  }

  private async listGitHubInstallationRepositories(input: {
    readonly installationId: string;
    readonly userId: string;
    readonly search?: string;
  }): Promise<InferSchema<typeof listGitHubInstallationRepositoriesResponseSchema>> {
    const params = githubInstallationIdParamsSchema.parse({ installationId: input.installationId });
    const query = githubInstallationRepositoriesQuerySchema.parse({
      userId: input.userId,
      search: input.search,
    });

    return this.requestJson({
      method: "GET",
      path: `/v1/github/installations/${encodeURIComponent(params.installationId)}/repositories`,
      schema: listGitHubInstallationRepositoriesResponseSchema,
      query,
    });
  }

  private async syncGitHubInstallation(input: {
    readonly installationId: string;
    readonly userId: string;
  }): Promise<InferSchema<typeof syncGitHubInstallationResponseSchema>> {
    const params = githubInstallationIdParamsSchema.parse({ installationId: input.installationId });
    const query = syncGitHubInstallationQuerySchema.parse({ userId: input.userId });

    return this.requestJson({
      method: "POST",
      path: `/v1/github/installations/${encodeURIComponent(params.installationId)}/sync`,
      schema: syncGitHubInstallationResponseSchema,
      query,
    });
  }

  private async resolvePackage(
    input: InferSchema<typeof resolvePackageQuerySchema>,
  ): Promise<InferSchema<typeof resolvePackageResponseSchema>> {
    const query = resolvePackageQuerySchema.parse(input);

    return this.requestJson({
      method: "GET",
      path: "/v1/packages/resolve",
      schema: resolvePackageResponseSchema,
      query,
    });
  }

  private buildUrl(
    path: string,
    query: Readonly<Record<string, string | number | undefined>> | undefined,
  ): URL {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);

    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) {
          continue;
        }

        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  private async requestJson<TOutput>(options: CoreApiRequestOptions<TOutput>): Promise<TOutput> {
    const url = this.buildUrl(options.path, options.query);
    const headers = new Headers(options.headers);

    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }

    const response = await this.fetchImplementation(url, {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const payload = await readJson(response);

    if (!response.ok) {
      const parsedMessageResponse = messageResponseSchema.safeParse(payload);
      const message = parsedMessageResponse.success
        ? parsedMessageResponse.data.message
        : `Core API request to ${url.toString()} failed with status ${response.status}.`;

      throw new CoreApiHttpError({
        message,
        status: response.status,
        url: url.toString(),
      });
    }

    return parseWithSchema(options.schema, payload);
  }

  private async createWorkspace(
    input: InferSchema<typeof createWorkspaceRequestSchema>,
    options: {
      readonly idempotencyKey?: string;
    } = {},
  ): Promise<InferSchema<typeof createWorkspaceResponseSchema>> {
    const payload = createWorkspaceRequestSchema.parse(input);

    return this.requestJson({
      method: "POST",
      path: "/v1/workspaces",
      schema: createWorkspaceResponseSchema,
      body: payload,
      ...(options.idempotencyKey === undefined
        ? {}
        : {
            headers: {
              "idempotency-key": options.idempotencyKey,
            },
          }),
    });
  }

  private async listWorkspaces(
    input: InferSchema<typeof listWorkspacesQuerySchema>,
  ): Promise<InferSchema<typeof listWorkspacesResponseSchema>> {
    const query = listWorkspacesQuerySchema.parse(input);

    return this.requestJson({
      method: "GET",
      path: "/v1/workspaces",
      schema: listWorkspacesResponseSchema,
      query,
    });
  }

  private async getWorkspace(
    input: InferSchema<typeof workspaceIdParamsSchema>,
  ): Promise<InferSchema<typeof workspaceDetailsSchema>> {
    const params = workspaceIdParamsSchema.parse(input);

    return this.requestJson({
      method: "GET",
      path: `/v1/workspaces/${encodeURIComponent(params.workspaceId)}`,
      schema: workspaceDetailsSchema,
    });
  }

  private async listWorkspaceAttempts(input: {
    readonly workspaceId: string;
    readonly limit?: number;
  }): Promise<InferSchema<typeof listWorkspaceAttemptsResponseSchema>> {
    const params = workspaceIdParamsSchema.parse({ workspaceId: input.workspaceId });
    const query = listWorkspaceAttemptsQuerySchema.parse({ limit: input.limit });

    return this.requestJson({
      method: "GET",
      path: `/v1/workspaces/${encodeURIComponent(params.workspaceId)}/attempts`,
      schema: listWorkspaceAttemptsResponseSchema,
      query,
    });
  }

  private async listWorkspaceEvents(input: {
    readonly workspaceId: string;
    readonly limit?: number;
  }): Promise<InferSchema<typeof listWorkspaceEventsResponseSchema>> {
    const params = workspaceIdParamsSchema.parse({ workspaceId: input.workspaceId });
    const query = listWorkspaceEventsQuerySchema.parse({ limit: input.limit });

    return this.requestJson({
      method: "GET",
      path: `/v1/workspaces/${encodeURIComponent(params.workspaceId)}/events`,
      schema: listWorkspaceEventsResponseSchema,
      query,
    });
  }

  private async renameWorkspace(input: {
    readonly workspaceId: string;
    readonly name: string;
  }): Promise<InferSchema<typeof renameWorkspaceResponseSchema>> {
    const params = workspaceIdParamsSchema.parse({ workspaceId: input.workspaceId });
    const payload = renameWorkspaceRequestSchema.parse({ name: input.name });

    return this.requestJson({
      method: "PATCH",
      path: `/v1/workspaces/${encodeURIComponent(params.workspaceId)}/name`,
      schema: renameWorkspaceResponseSchema,
      body: payload,
    });
  }
}

export const createCoreApiClient = (options: CreateCoreApiClientOptions = {}): CoreApiClient => {
  return new CoreApiClientImpl(options);
};
