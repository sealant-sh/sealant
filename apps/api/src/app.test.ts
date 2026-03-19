import type { RegistryClient } from "@sealant/registry-integration";
import { describe, expect, it } from "vitest";

import { createApiApp } from "./app.js";
import type { AppEnv } from "./env.js";

const testEnv: AppEnv = {
  NODE_ENV: "test",
  PORT: 3000,
  REGISTRY_NAME: "default",
  REGISTRY_BASE_URL: "http://127.0.0.1:5000",
  REGISTRY_PUSH_REGISTRY: "127.0.0.1:5000",
};

const createRegistryClientStub = (): RegistryClient => {
  return {
    ping: async () => undefined,
    repositoryExists: async () => true,
    listTags: async () => ["latest", "opencode"],
    getManifest: async () => ({
      digest: "sha256:test",
      contentType: "application/vnd.oci.image.manifest.v1+json",
      body: {
        schemaVersion: 2,
      },
    }),
    headManifest: async () => "sha256:test",
    discoverExtensions: async () => [
      {
        name: "_zot",
        endpoints: ["/v2/_zot/ext/search"],
      },
    ],
    publishOciImage: async () => ({
      repository: "sealant/workspaces/demo",
      tag: "opencode",
      reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
      digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
      digest: "sha256:test",
    }),
  };
};

describe("createApiApp", () => {
  it("serves the system health endpoint", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
    });

    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
    });
  });

  it("serves registry-backed tag lookup", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
    });

    const response = await app.request(
      "/v1/registries/default/tags?repository=sealant/workspaces/demo",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repository: "sealant/workspaces/demo",
      tags: ["latest", "opencode"],
    });
  });

  it("serves the generated OpenAPI document", async () => {
    const app = createApiApp({
      env: testEnv,
      registryClient: createRegistryClientStub(),
    });

    const response = await app.request("/openapi.json");

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      paths: Record<string, unknown>;
      info: {
        title: string;
      };
    };

    expect(body.info.title).toBe("Sealant Control Plane API");
    expect(body.paths["/v1/registries/{registryId}/ping"]).toBeDefined();
    expect(body.paths["/healthz"]).toBeDefined();
  });
});
