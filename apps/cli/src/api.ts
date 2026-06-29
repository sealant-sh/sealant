/** Thin HTTP client over the control-plane API — the renderer-agnostic data layer for the CLI. */
import type { CliConfig } from "./config.js";

export type CredentialProvider = "github" | "claude" | "codex";
export type CredentialKind = "oauth" | "api_key" | "session_file";
export type CredentialPayloadShape = "oauth_token_set" | "api_key" | "raw_file";

export interface SandboxSummary {
  readonly sandboxId: string;
  readonly name: string;
  readonly status: string;
  readonly repository?: string;
  readonly tag?: string;
  readonly createdAt: string;
}

export interface CredentialMetadata {
  readonly id: string;
  readonly provider: CredentialProvider;
  readonly kind: CredentialKind;
  readonly status: string;
  readonly label?: string;
  readonly accountIdentifier?: string;
  readonly last4?: string;
  readonly expiresAt?: string;
  readonly connectedAt: string;
}

export interface ConnectCredentialInput {
  readonly provider: CredentialProvider;
  readonly kind: CredentialKind;
  readonly payloadShape: CredentialPayloadShape;
  readonly secret: string;
  readonly label?: string;
  readonly accountIdentifier?: string;
}

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const request = async <T>(
  config: CliConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (config.apiKey !== undefined) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      detail = parsed.message ?? text;
    } catch {
      // keep raw text
    }
    throw new ApiError(response.status, detail || `HTTP ${response.status}`);
  }
  return (text.length === 0 ? undefined : JSON.parse(text)) as T;
};

export const listSandboxes = async (config: CliConfig): Promise<readonly SandboxSummary[]> => {
  const query = new URLSearchParams({ ownerUserId: config.ownerUserId, limit: "50" });
  const result = await request<{ items: readonly SandboxSummary[] }>(
    config,
    "GET",
    `/v1/sandboxes?${query.toString()}`,
  );
  return result.items;
};

export const connectCredential = async (
  config: CliConfig,
  input: ConnectCredentialInput,
): Promise<CredentialMetadata> =>
  request<CredentialMetadata>(config, "POST", "/v1/credentials", {
    ownerUserId: config.ownerUserId,
    ...input,
  });

export const listCredentials = async (config: CliConfig): Promise<readonly CredentialMetadata[]> => {
  const query = new URLSearchParams({ ownerUserId: config.ownerUserId });
  const result = await request<{ items: readonly CredentialMetadata[] }>(
    config,
    "GET",
    `/v1/credentials?${query.toString()}`,
  );
  return result.items;
};
