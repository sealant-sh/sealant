import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const packageTargetOsSchema = Schema.Literals(["arch", "fedora", "nix"]);
export type PackageTargetOs = typeof packageTargetOsSchema.Type;

export const packageResolutionStatusSchema = Schema.Literals([
  "resolved",
  "ambiguous",
  "unsupported",
  "not-found",
  "invalid",
]);

export const packageResolutionSourceSchema = Schema.Literals(["cache", "repology", "override"]);

export const packageOsSupportSchema = Schema.Struct({
  supported: Schema.Boolean,
  repo: Schema.optional(NonEmptyString),
  packageName: Schema.optional(NonEmptyString),
  projectName: Schema.optional(NonEmptyString),
  version: Schema.optional(NonEmptyString),
  status: Schema.optional(NonEmptyString),
});

export const packageResolutionAlternativeSchema = Schema.Struct({
  projectName: NonEmptyString,
});

export const packageResolutionSchema = Schema.Struct({
  requested: NonEmptyString,
  normalized: NonEmptyString,
  status: packageResolutionStatusSchema,
  source: packageResolutionSourceSchema,
  canonicalId: Schema.optional(NonEmptyString),
  selectedProject: Schema.optional(NonEmptyString),
  osSupport: Schema.Struct({
    arch: packageOsSupportSchema,
    fedora: packageOsSupportSchema,
    nix: packageOsSupportSchema,
  }),
  alternatives: Schema.Array(packageResolutionAlternativeSchema),
  fetchedAt: Schema.String,
  expiresAt: Schema.String,
});
export type PackageResolution = typeof packageResolutionSchema.Type;

export const resolvePackageQuerySchema = Schema.Struct({
  query: NonEmptyString,
  targetOs: Schema.optional(packageTargetOsSchema),
});
export type ResolvePackageQuery = typeof resolvePackageQuerySchema.Type;

export const resolvePackageResponseSchema = packageResolutionSchema;
export type ResolvePackageResponse = typeof resolvePackageResponseSchema.Type;

export class PackagesBadGatewayError extends Schema.TaggedErrorClass<PackagesBadGatewayError>()(
  "PackagesBadGatewayError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 502 },
) {}

export class PackagesInternalServerError extends Schema.TaggedErrorClass<PackagesInternalServerError>()(
  "PackagesInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export const PackagesGroup = HttpApiGroup.make("packages")
  .add(
    HttpApiEndpoint.get("resolvePackage", "/resolve", {
      query: resolvePackageQuerySchema,
      success: resolvePackageResponseSchema,
      error: [PackagesBadGatewayError, PackagesInternalServerError],
    }),
  )
  .annotate(OpenApi.Description, "Package normalization and distro resolution operations.");
