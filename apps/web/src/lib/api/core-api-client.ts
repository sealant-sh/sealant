import { messageResponseSchema } from "../../../../api/src/lib/schemas";
import {
  createSandboxRequestSchema,
  createSandboxResponseSchema,
  listSandboxAttemptsQuerySchema,
  listSandboxAttemptsResponseSchema,
  listSandboxEventsQuerySchema,
  listSandboxEventsResponseSchema,
  listSandboxesQuerySchema,
  listSandboxesResponseSchema,
  sandboxDetailsSchema,
  sandboxIdParamsSchema,
} from "../../../../api/src/routes/sandboxes/sandboxes.schemas";

const DEFAULT_CORE_API_URL = "http://localhost:3001";

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
  readonly method: "GET" | "POST";
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
  const configuredBaseUrl = process.env.VITE_API_URL;

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
  readonly sandboxes: {
    create(
      input: InferSchema<typeof createSandboxRequestSchema>,
      options?: {
        readonly idempotencyKey?: string;
      },
    ): Promise<InferSchema<typeof createSandboxResponseSchema>>;
    list(
      input: InferSchema<typeof listSandboxesQuerySchema>,
    ): Promise<InferSchema<typeof listSandboxesResponseSchema>>;
    byId(
      input: InferSchema<typeof sandboxIdParamsSchema>,
    ): Promise<InferSchema<typeof sandboxDetailsSchema>>;
    attempts(input: {
      readonly sandboxId: string;
      readonly limit?: number;
    }): Promise<InferSchema<typeof listSandboxAttemptsResponseSchema>>;
    events(input: {
      readonly sandboxId: string;
      readonly limit?: number;
    }): Promise<InferSchema<typeof listSandboxEventsResponseSchema>>;
  };
}

class CoreApiClientImpl implements CoreApiClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  public readonly sandboxes: CoreApiClient["sandboxes"];

  public constructor(options: CreateCoreApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? getCoreApiBaseUrl());
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sandboxes = {
      create: (input, requestOptions) => this.createSandbox(input, requestOptions),
      list: (input) => this.listSandboxes(input),
      byId: (input) => this.getSandbox(input),
      attempts: (input) => this.listSandboxAttempts(input),
      events: (input) => this.listSandboxEvents(input),
    };
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
        : `Core API request failed with status ${response.status}.`;

      throw new CoreApiHttpError({
        message,
        status: response.status,
        url: url.toString(),
      });
    }

    return parseWithSchema(options.schema, payload);
  }

  private async createSandbox(
    input: InferSchema<typeof createSandboxRequestSchema>,
    options: {
      readonly idempotencyKey?: string;
    } = {},
  ): Promise<InferSchema<typeof createSandboxResponseSchema>> {
    const payload = createSandboxRequestSchema.parse(input);

    return this.requestJson({
      method: "POST",
      path: "/v1/sandboxes",
      schema: createSandboxResponseSchema,
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

  private async listSandboxes(
    input: InferSchema<typeof listSandboxesQuerySchema>,
  ): Promise<InferSchema<typeof listSandboxesResponseSchema>> {
    const query = listSandboxesQuerySchema.parse(input);

    return this.requestJson({
      method: "GET",
      path: "/v1/sandboxes",
      schema: listSandboxesResponseSchema,
      query,
    });
  }

  private async getSandbox(
    input: InferSchema<typeof sandboxIdParamsSchema>,
  ): Promise<InferSchema<typeof sandboxDetailsSchema>> {
    const params = sandboxIdParamsSchema.parse(input);

    return this.requestJson({
      method: "GET",
      path: `/v1/sandboxes/${encodeURIComponent(params.sandboxId)}`,
      schema: sandboxDetailsSchema,
    });
  }

  private async listSandboxAttempts(input: {
    readonly sandboxId: string;
    readonly limit?: number;
  }): Promise<InferSchema<typeof listSandboxAttemptsResponseSchema>> {
    const params = sandboxIdParamsSchema.parse({ sandboxId: input.sandboxId });
    const query = listSandboxAttemptsQuerySchema.parse({ limit: input.limit });

    return this.requestJson({
      method: "GET",
      path: `/v1/sandboxes/${encodeURIComponent(params.sandboxId)}/attempts`,
      schema: listSandboxAttemptsResponseSchema,
      query,
    });
  }

  private async listSandboxEvents(input: {
    readonly sandboxId: string;
    readonly limit?: number;
  }): Promise<InferSchema<typeof listSandboxEventsResponseSchema>> {
    const params = sandboxIdParamsSchema.parse({ sandboxId: input.sandboxId });
    const query = listSandboxEventsQuerySchema.parse({ limit: input.limit });

    return this.requestJson({
      method: "GET",
      path: `/v1/sandboxes/${encodeURIComponent(params.sandboxId)}/events`,
      schema: listSandboxEventsResponseSchema,
      query,
    });
  }
}

export const createCoreApiClient = (options: CreateCoreApiClientOptions = {}): CoreApiClient => {
  return new CoreApiClientImpl(options);
};
