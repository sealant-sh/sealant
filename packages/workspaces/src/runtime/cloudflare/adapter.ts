/**
 * Cloudflare runtime adapter: `supports` / `launch` / `stop` against the bridge Worker's
 * authenticated HTTP API (deploy/cloudflare). Sandboxes can only be driven from inside a Worker,
 * so the bridge owns the Durable Object + sandbox lifecycle; this adapter is a thin, honest
 * client of it. The control channel comes back as a `wss://` endpoint the bridge proxies to
 * sealantd inside the sandbox, authenticated per-connection with the deployment's control bearer
 * token (`SEALANT_CONTROL_BEARER_TOKEN`, see `sealantd/target.ts`).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterStopInput,
  type RuntimeAdapter,
  type RuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchResult,
  type RuntimeAdapterStopInput,
  type RuntimeAdapterStopResult,
  type RuntimeAdapterSupport,
  type RuntimeAdapterSupportInput,
} from "../runtime-adapter.js";
import {
  BRIDGE_CONTRACT_VERSION,
  bridgeErrorResponseSchema,
  bridgeLaunchResponseSchema,
  bridgeStopResponseSchema,
  type BridgeLaunchRequest,
} from "./bridge-contract.js";
import type { CloudflareRuntimeConfig } from "./config.js";

/** Inline dotfiles ride the launch request; refuse silliness rather than time out mid-upload. */
const MAX_INLINE_DOTFILES_BYTES = 8 * 1024 * 1024;

export interface CloudflareRuntimeAdapterOptions {
  readonly config: CloudflareRuntimeConfig;
  /** Test seam; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** The support decision, pure. Exported for direct unit testing (mirrors `supportForKubernetes`). */
export const supportForCloudflare = (input: RuntimeAdapterSupportInput): RuntimeAdapterSupport => {
  const family = input.blueprint.target.runtime.family;
  if (family !== "auto" && family !== "cloudflare") {
    return {
      supported: false,
      reason: "unsupported-runtime",
      message: `The cloudflare adapter cannot serve runtime family '${family}'.`,
    };
  }
  if (input.blueprint.runtime.persistence !== "ephemeral") {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The cloudflare adapter only supports ephemeral persistence.",
    };
  }
  if (!input.blueprint.runtime.network.outbound) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The cloudflare adapter cannot disable outbound network access for a sandbox.",
    };
  }
  if (input.blueprint.tooling.services?.docker?.enabled === true) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "Workspace-scoped Docker (tooling.services.docker) is not available in Cloudflare sandboxes.",
    };
  }
  if (input.blueprint.runtime.ociRuntime === "runsc") {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "ociRuntime 'runsc' is not selectable on Cloudflare; sandbox isolation is the platform's own.",
    };
  }
  if (input.blueprint.sources.workspace.kind === "mount") {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "A mount workspace source names a host path no Cloudflare sandbox can see; use a git source (the co-located store model does not extend to this runtime).",
    };
  }
  if (input.blueprint.sources.mounts.length > 0) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "Extra host mounts (sources.mounts) are not available in Cloudflare sandboxes.",
    };
  }
  return { supported: true };
};

export class CloudflareRuntimeAdapter implements RuntimeAdapter {
  readonly id = "cloudflare" as const;

  readonly #config: CloudflareRuntimeConfig;
  readonly #fetch: typeof fetch;

  constructor(options: CloudflareRuntimeAdapterOptions) {
    this.#config = options.config;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport {
    return supportForCloudflare(input);
  }

  async launch(input: RuntimeAdapterLaunchInput): Promise<RuntimeAdapterLaunchResult> {
    const parsed = parseRuntimeAdapterLaunchInput(input);
    if (parsed.runId === undefined) {
      throw new Error(
        "The cloudflare adapter needs launch.runId: the bridge keys sandbox identity on the run so a redelivered launch adopts instead of duplicating.",
      );
    }
    const source = parsed.blueprint.sources.workspace;
    if (source.kind !== "git") {
      // supports() already rejected mount sources; this guards direct launch calls.
      throw new Error("The cloudflare adapter can only launch git workspace sources.");
    }
    if (parsed.workspaceCloneAuth?.type === "file-ref") {
      throw new Error(
        "file-ref clone auth names a key file on the worker host; the cloudflare bridge only takes http-token auth.",
      );
    }

    const request: BridgeLaunchRequest = {
      version: BRIDGE_CONTRACT_VERSION,
      runId: parsed.runId,
      ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
      ...(parsed.principalId === undefined ? {} : { principalId: parsed.principalId }),
      source: {
        url: source.url,
        ...(source.ref === undefined ? {} : { ref: source.ref }),
        ...(parsed.workspaceCloneAuth?.type === "http-token"
          ? {
              auth: {
                username: parsed.workspaceCloneAuth.username,
                token: parsed.workspaceCloneAuth.token,
              },
            }
          : {}),
      },
      image: parsed.publishedImage,
      // Later wins, matching the docker adapter's -e ordering: blueprint env, then
      // worker-resolved platform env (must not be shadowed), then credential env.
      env: {
        ...parsed.blueprint.runtime.env,
        ...parsed.platformEnv,
        ...parsed.credentialEnv,
      },
      ...(parsed.secretEnv === undefined || Object.keys(parsed.secretEnv).length === 0
        ? {}
        : { secretEnv: parsed.secretEnv }),
      ...(parsed.credentialFiles === undefined || parsed.credentialFiles.length === 0
        ? {}
        : { credentialFiles: parsed.credentialFiles }),
      ...(await inlineDotfiles(parsed.dotfilesArchiveDir)),
    };

    const response = await this.#bridge("POST", "/v1/workspaces", request);
    const body = bridgeLaunchResponseSchema.parse(await response.json());
    return {
      adapter: this.id,
      resourceId: body.resourceId,
      reference: body.reference ?? body.resourceId,
      status: body.status,
      endpoint: body.controlEndpoint,
    };
  }

  async stop(input: RuntimeAdapterStopInput): Promise<RuntimeAdapterStopResult> {
    const parsed = parseRuntimeAdapterStopInput(input);
    const response = await this.#bridge(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(parsed.resourceId)}`,
      undefined,
      // A sandbox the bridge no longer knows is a successful stop, same as a missing container.
      [404],
    );
    if (response.status === 404) {
      return { adapter: this.id, resourceId: parsed.resourceId, outcome: "not-found" };
    }
    const body = bridgeStopResponseSchema.parse(await response.json());
    return { adapter: this.id, resourceId: parsed.resourceId, outcome: body.outcome };
  }

  async #bridge(
    method: "POST" | "DELETE",
    route: string,
    body: unknown,
    allowedStatuses: readonly number[] = [],
  ): Promise<Response> {
    const response = await this.#fetch(`${this.#config.bridgeUrl}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#config.bridgeToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      const message = await response
        .json()
        .then((payload) => bridgeErrorResponseSchema.parse(payload).message)
        .catch(() => `the bridge answered ${response.status} with no readable message`);
      throw new Error(`cloudflare bridge ${method} ${route} failed: ${message}`);
    }
    return response;
  }
}

/** The slice of `manifest.json` this reader needs (full shape: `launch-material.ts`). */
const stagedManifestSchema = z.object({
  archives: z.array(z.object({ file: z.string().trim().min(1) })),
});

/** Read the worker-staged dotfiles material and inline it (no shared filesystem to mount). */
const inlineDotfiles = async (
  dotfilesArchiveDir: string | undefined,
): Promise<Pick<BridgeLaunchRequest, "dotfiles">> => {
  if (dotfilesArchiveDir === undefined) {
    return {};
  }
  const manifestJson = await readFile(path.join(dotfilesArchiveDir, "manifest.json"), "utf8");
  const manifest = stagedManifestSchema.parse(JSON.parse(manifestJson));
  let total = 0;
  const archives = await Promise.all(
    manifest.archives.map(async (entry) => {
      const name = path.basename(entry.file);
      const content = await readFile(path.join(dotfilesArchiveDir, name));
      total += content.byteLength;
      return { name, contentBase64: content.toString("base64") };
    }),
  );
  if (total > MAX_INLINE_DOTFILES_BYTES) {
    throw new Error(
      `dotfiles archives total ${total} bytes; the cloudflare bridge takes at most ${MAX_INLINE_DOTFILES_BYTES} inline.`,
    );
  }
  if (archives.length === 0) {
    return {};
  }
  return { dotfiles: { manifestJson, archives } };
};
