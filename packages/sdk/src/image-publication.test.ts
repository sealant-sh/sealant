import { afterEach, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import { opencode } from "./harness.js";
import { buildCreateWorkspaceRequest } from "./internal/blueprint.js";
import { resolveInternalConfig } from "./internal/config.js";
import type { WorkspacePublication } from "./types.js";

const config = resolveInternalConfig({ baseUrl: "http://test.invalid", ownerUserId: "usr_owner" });
const options = { repository: "github.com/example/repo", harness: opencode() };
const hash = "a".repeat(64);
const native: WorkspacePublication = {
  kind: "boat-native",
  publicationId: "00000000-0000-4000-8000-000000000001",
  snapshot: {
    kind: "boat-saved-snapshot",
    owner: "00000000-0000-4000-8000-000000000002",
    build: "00000000-0000-4000-8000-000000000003",
    recipeHash: hash,
    receiptHash: hash,
    identity: {
      name: "test-native",
      sourceSandboxId: "bx_23456789",
      createdAt: "2026-11-05T00:00:00.000Z",
      snapshotId: "exact-snapshot",
    },
  },
  evidence: {
    recipeHash: hash,
    receiptHash: hash,
    assetsHash: hash,
    runtime: {
      source: `ghcr.io/sealant-sh/sealantd-next:test@sha256:${hash}`,
      platform: "linux/amd64",
      manifest: hash,
      sealantd: hash,
      sealantctl: hash,
    },
    daemonRecovery: "supported",
    executorRecovery: "unverified",
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("image scope and typed publications", () => {
  it("preserves an explicit scope at the payload boundary and omits it by default", () => {
    const scope = "rdm:00000000-0000-4000-8000-000000000001";
    const selected = buildCreateWorkspaceRequest(
      { ...options, imageScopeId: scope },
      config,
    ).payload;
    expect(selected.imageScopeId).toBe(scope);
    expect(JSON.stringify(selected.spec)).not.toContain(scope);
    expect(buildCreateWorkspaceRequest(options, config).payload).not.toHaveProperty("imageScopeId");
  });
  it("reads native and MicroVM facts without inventing OCI coordinates", async () => {
    let publication: WorkspacePublication = native;
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            workspaceId: "ws_test",
            name: "test",
            ownerUserId: "usr_owner",
            status: "ready",
            publication,
            createdAt: "2026-11-05T00:00:00.000Z",
            updatedAt: "2026-11-05T00:00:00.000Z",
            attempts: [],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = new Sealant({ baseUrl: "http://test.invalid", ownerUserId: "usr_owner" });
    try {
      for (const next of [
        native,
        {
          kind: "microvm",
          publicationId: "job_microvm",
          image: {
            imageArn: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:example",
            imageVersion: "1.0",
            planHash: hash,
          },
        },
      ] satisfies WorkspacePublication[]) {
        publication = next;
        const workspace = await client.workspaces.get("ws_test");
        expect(await workspace.publication()).toEqual(publication);
        expect(await workspace.image()).toBeNull();
      }
    } finally {
      await client.close();
    }
  });
});
