import type { ManifestResponse, OciImageManifest, RegistrySummary, TagsResponse } from "./types";

export const MOCK_REGISTRIES: RegistrySummary[] = [
  {
    id: "local-dev",
    name: "local-dev",
    baseUrl: "http://127.0.0.1:5000",
    pushRegistry: "127.0.0.1:5000",
    hasBasicAuth: false,
  },
  {
    id: "staging",
    name: "staging",
    baseUrl: "https://registry.staging.sealant.internal",
    pushRegistry: "registry.staging.sealant.internal",
    hasBasicAuth: true,
  },
  {
    id: "production",
    name: "production",
    baseUrl: "https://registry.prod.sealant.internal",
    pushRegistry: "registry.prod.sealant.internal",
    hasBasicAuth: true,
  },
];

export const MOCK_REPOSITORIES: Record<string, string[]> = {
  "local-dev": [
    "sandbox/opencode",
    "sandbox/claude-code",
    "sandbox/codex",
    "base/fedora-dev",
    "base/arch-dev",
  ],
  staging: ["sandbox/opencode", "sandbox/claude-code", "base/fedora-dev"],
  production: ["sandbox/opencode", "sandbox/claude-code"],
};

export const MOCK_TAGS: Record<string, TagsResponse> = {
  "local-dev/sandbox/opencode": {
    repository: "sandbox/opencode",
    tags: ["latest", "v0.1.4", "v0.1.3", "sha-3f8a2c1", "sha-9e4b7d0"],
  },
  "local-dev/sandbox/claude-code": {
    repository: "sandbox/claude-code",
    tags: ["latest", "v1.2.0", "v1.1.0", "sha-abc1234"],
  },
  "local-dev/sandbox/codex": {
    repository: "sandbox/codex",
    tags: ["latest", "v2.0.1", "sha-ff00cc3"],
  },
  "local-dev/base/fedora-dev": {
    repository: "base/fedora-dev",
    tags: ["latest", "f41", "f40"],
  },
  "local-dev/base/arch-dev": {
    repository: "base/arch-dev",
    tags: ["latest", "2026.03.01"],
  },
  "staging/sandbox/opencode": {
    repository: "sandbox/opencode",
    tags: ["latest", "v0.1.4", "sha-3f8a2c1"],
  },
  "staging/sandbox/claude-code": {
    repository: "sandbox/claude-code",
    tags: ["latest", "v1.2.0"],
  },
  "staging/base/fedora-dev": {
    repository: "base/fedora-dev",
    tags: ["latest", "f41"],
  },
  "production/sandbox/opencode": {
    repository: "sandbox/opencode",
    tags: ["v0.1.3", "sha-9e4b7d0"],
  },
  "production/sandbox/claude-code": {
    repository: "sandbox/claude-code",
    tags: ["v1.1.0"],
  },
};

function makeManifest(repository: string, reference: string): ManifestResponse {
  const digest = `sha256:${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;

  const manifest: OciImageManifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      size: 7023,
      digest: `sha256:${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        size: 183_932_416,
        digest: `sha256:${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`,
      },
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        size: 42_893_312,
        digest: `sha256:${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`,
      },
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        size: 8_192_000,
        digest: `sha256:${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`,
      },
    ],
  };

  return {
    repository,
    reference,
    digest,
    contentType: "application/vnd.oci.image.manifest.v1+json",
    manifest,
  };
}

export function getMockManifest(
  _registryId: string,
  repository: string,
  reference: string,
): ManifestResponse {
  // Return deterministic-ish manifest based on the key
  return makeManifest(repository, reference);
}
