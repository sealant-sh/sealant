/**
 * Registry service — mock implementation.
 *
 * Each function is the future integration point for real API calls.
 * To wire up the real API, replace the mock implementations with:
 *
 *   const base = import.meta.env.VITE_API_URL
 *   const res = await fetch(`${base}/v1/registries/${registryId}`)
 *   return res.json()
 */

import type { ManifestResponse, RegistrySummary, TagsResponse } from "./types"
import {
  getMockManifest,
  MOCK_REGISTRIES,
  MOCK_REPOSITORIES,
  MOCK_TAGS,
} from "./mock-data"

/** Simulate realistic API latency */
function delay(ms = 200 + Math.random() * 200): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Registries ───────────────────────────────────────────────────────────────

/**
 * List all configured registry instances.
 * TODO: replace with GET ${VITE_API_URL}/v1/registries
 */
export async function listRegistries(): Promise<RegistrySummary[]> {
  await delay()
  return MOCK_REGISTRIES
}

/**
 * Get a single registry's metadata.
 * TODO: replace with GET ${VITE_API_URL}/v1/registries/:registryId
 */
export async function getRegistry(registryId: string): Promise<RegistrySummary> {
  await delay()
  const registry = MOCK_REGISTRIES.find((r) => r.id === registryId)
  if (!registry) {
    throw new Error(`Registry not found: ${registryId}`)
  }
  return registry
}

// ─── Repositories ─────────────────────────────────────────────────────────────

/**
 * List repositories available in a registry.
 * TODO: replace with GET ${VITE_API_URL}/v1/registries/:registryId/catalog
 *       (OCI Distribution Spec /_catalog, proxied through the API)
 */
export async function listRepositories(registryId: string): Promise<string[]> {
  await delay()
  return MOCK_REPOSITORIES[registryId] ?? []
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

/**
 * List tags for a repository in a registry.
 * TODO: replace with GET ${VITE_API_URL}/v1/registries/:registryId/tags?repository=:repo
 */
export async function getRepositoryTags(
  registryId: string,
  repository: string
): Promise<TagsResponse> {
  await delay()
  const key = `${registryId}/${repository}`
  const result = MOCK_TAGS[key]
  if (!result) {
    return { repository, tags: [] }
  }
  return result
}

// ─── Manifests ────────────────────────────────────────────────────────────────

/**
 * Fetch a manifest for a specific image reference.
 * TODO: replace with GET ${VITE_API_URL}/v1/registries/:registryId/manifest?repository=:repo&reference=:ref
 */
export async function getManifest(
  registryId: string,
  repository: string,
  reference: string
): Promise<ManifestResponse> {
  await delay()
  return getMockManifest(registryId, repository, reference)
}
