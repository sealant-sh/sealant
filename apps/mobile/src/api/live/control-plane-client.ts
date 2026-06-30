import type { SandboxAttempt, SandboxEvent, SandboxStatus, SandboxSummary } from "../types/models";

const apiBaseUrl = process.env.EXPO_PUBLIC_SEALANT_API_BASE_URL ?? "http://localhost:4000";
const ownerUserId = process.env.EXPO_PUBLIC_SEALANT_DEMO_USER_ID ?? "user-demo";

interface ListResponse<Item> {
  readonly items: readonly Item[];
}

interface LiveSandboxRuntime {
  readonly adapter: "docker" | "k8s" | "k3s";
  readonly resourceId: string;
  readonly reference: string;
  readonly status: "pending" | "running" | "ready" | "failed" | "stopped";
  readonly endpoint?: string;
}

interface LiveSandboxSummary {
  readonly sandboxId: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly status: SandboxStatus;
  readonly registryId?: string;
  readonly repository?: string;
  readonly tag?: string;
  readonly runtime?: LiveSandboxRuntime;
  readonly error?: {
    readonly message: string;
    readonly code?: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

type LiveSandboxAttempt = SandboxAttempt;
type LiveSandboxEvent = SandboxEvent;

const makeUrl = (path: string, params: Record<string, string> = {}) => {
  const url = new URL(path, apiBaseUrl);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
};

const requestJson = async <Value>(url: string, init?: RequestInit): Promise<Value> => {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");

  const response = await fetch(url, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(`Sealant API request failed: ${response.status}`);
  }

  return response.json();
};

const toSandboxSummary = (sandbox: LiveSandboxSummary): SandboxSummary => {
  return {
    sandboxId: sandbox.sandboxId,
    name: sandbox.name,
    ownerUserId: sandbox.ownerUserId,
    status: sandbox.status,
    ...(sandbox.registryId === undefined ? {} : { registryId: sandbox.registryId }),
    ...(sandbox.repository === undefined ? {} : { repository: sandbox.repository }),
    ...(sandbox.tag === undefined ? {} : { tag: sandbox.tag }),
    ...(sandbox.runtime === undefined ? {} : { runtime: sandbox.runtime }),
    ...(sandbox.error === undefined ? {} : { error: sandbox.error }),
    createdAt: sandbox.createdAt,
    updatedAt: sandbox.updatedAt,
    ...(sandbox.startedAt === undefined ? {} : { startedAt: sandbox.startedAt }),
    ...(sandbox.finishedAt === undefined ? {} : { finishedAt: sandbox.finishedAt }),
  };
};

export const controlPlaneClient = {
  listSandboxes: async (): Promise<readonly SandboxSummary[]> => {
    const response = await requestJson<ListResponse<LiveSandboxSummary>>(
      makeUrl("/v1/sandboxes", {
        ownerUserId,
        limit: "25",
      }),
    );

    return response.items.map(toSandboxSummary);
  },

  getSandbox: async (sandboxId: string): Promise<SandboxSummary | null> => {
    try {
      const sandbox = await requestJson<LiveSandboxSummary>(makeUrl(`/v1/sandboxes/${sandboxId}`));
      return toSandboxSummary(sandbox);
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return null;
      }

      throw error;
    }
  },

  listSandboxAttempts: async (sandboxId: string): Promise<readonly SandboxAttempt[]> => {
    const response = await requestJson<ListResponse<LiveSandboxAttempt>>(
      makeUrl(`/v1/sandboxes/${sandboxId}/attempts`, {
        limit: "25",
      }),
    );

    return response.items;
  },

  listSandboxEvents: async (sandboxId: string): Promise<readonly SandboxEvent[]> => {
    const response = await requestJson<ListResponse<LiveSandboxEvent>>(
      makeUrl(`/v1/sandboxes/${sandboxId}/events`, {
        limit: "50",
      }),
    );

    return response.items;
  },
};
