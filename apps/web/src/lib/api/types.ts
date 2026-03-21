/**
 * API type contracts — mirror the Zod schemas in apps/api/src/routes/registries/
 * These types are used for both mock data and future real API integration.
 */

export interface RegistrySummary {
  /** Routing ID — maps to REGISTRY_NAME env var in the API */
  id: string;
  name: string;
  baseUrl: string;
  pushRegistry: string;
  hasBasicAuth: boolean;
}

export interface TagsResponse {
  repository: string;
  tags: string[];
}

export interface OciManifestLayer {
  mediaType: string;
  size: number;
  digest: string;
}

export interface OciManifestConfig {
  mediaType: string;
  size: number;
  digest: string;
}

export interface OciImageManifest {
  schemaVersion: number;
  mediaType: string;
  config: OciManifestConfig;
  layers: OciManifestLayer[];
}

export interface ManifestResponse {
  repository: string;
  reference: string;
  digest?: string;
  contentType: string | null;
  manifest: unknown;
}
