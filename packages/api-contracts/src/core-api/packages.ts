import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform";
import { Schema } from "effect";

const NonEmptyString = Schema.NonEmptyTrimmedString;

export const packageTargetOsSchema = Schema.Literal("arch", "fedora", "nix");
export type PackageTargetOs = typeof packageTargetOsSchema.Type;

export const packageResolutionStatusSchema = Schema.Literal(
  "resolved",
  "ambiguous",
  "unsupported",
  "not-found",
  "invalid",
);

export const packageResolutionSourceSchema = Schema.Literal("cache", "repology", "override");

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

export class PackagesBadGatewayError extends Schema.TaggedError<PackagesBadGatewayError>(
  "PackagesBadGatewayError",
)(
  "PackagesBadGatewayError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 502 }),
) {}

export class PackagesInternalServerError extends Schema.TaggedError<PackagesInternalServerError>(
  "PackagesInternalServerError",
)(
  "PackagesInternalServerError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}

export const PackagesGroup = HttpApiGroup.make("packages")
  .add(
    HttpApiEndpoint.get("resolvePackage", "/resolve")
      .setUrlParams(resolvePackageQuerySchema)
      .addSuccess(resolvePackageResponseSchema)
      .addError(PackagesBadGatewayError)
      .addError(PackagesInternalServerError),
  )
  .annotate(OpenApi.Description, "Package normalization and distro resolution operations.");
