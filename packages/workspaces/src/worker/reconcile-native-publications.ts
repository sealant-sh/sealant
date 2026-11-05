import type { BoatNativeCatalogService } from "../images/boat/catalog.js";

/** One bounded page per tick. The composition root keeps the returned cursor for the next tick. */
export const reconcileNativePublications = (input: {
  readonly catalog: Pick<BoatNativeCatalogService, "reconcile">;
  readonly limit: number;
  readonly after?: string;
}) =>
  input.catalog.reconcile({
    limit: Math.min(100, Math.max(1, Math.floor(input.limit))),
    ...(input.after === undefined ? {} : { after: input.after }),
  });
