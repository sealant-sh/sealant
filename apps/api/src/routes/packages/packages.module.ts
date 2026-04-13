import {
  PackagesBadGatewayError,
  type ResolvePackageQuery,
  type ResolvePackageResponse,
} from "@sealant/api-contracts";
import { SandboxesService } from "@sealant/sandboxes";
import { Effect } from "effect";

const toErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

export const resolvePackage = (query: ResolvePackageQuery) => {
  return Effect.gen(function* () {
    const sandboxes = yield* SandboxesService;
    const targetOs = query.targetOs ?? "fedora";

    const resolution = yield* sandboxes
      .resolvePackage({
        query: query.query,
        targetOs,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new PackagesBadGatewayError({
              message: toErrorMessage(error, "Package resolution failed."),
            }),
        ),
      );

    return resolution satisfies ResolvePackageResponse;
  });
};
