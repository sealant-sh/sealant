import {
  PackagesBadGatewayError,
  type ResolvePackageQuery,
  type ResolvePackageResponse,
} from "@sealant/api-contracts";
import { Effect } from "effect";

import { PackageStandardizerService } from "../../services/control-plane-capabilities.js";

const toErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

export const resolvePackage = (query: ResolvePackageQuery) => {
  return Effect.gen(function* () {
    const packageStandardizer = yield* PackageStandardizerService;
    const targetOs = query.targetOs ?? "fedora";

    return yield* Effect.tryPromise({
      try: () =>
        packageStandardizer.resolvePackage({
          query: query.query,
          targetOs,
        }),
      catch: (error) =>
        new PackagesBadGatewayError({
          message: toErrorMessage(error, "Package resolution failed."),
        }),
    }).pipe(Effect.map((resolution) => resolution satisfies ResolvePackageResponse));
  });
};
