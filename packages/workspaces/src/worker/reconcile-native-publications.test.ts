import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { BoatNativeCatalogService } from "../images/boat/catalog.js";
import { reconcileNativePublications } from "./reconcile-native-publications.js";

describe("native reconciliation composition", () => {
  it("bounds each tick and carries unresolved entries and the continuation cursor", async () => {
    const calls: Parameters<BoatNativeCatalogService["reconcile"]>[0][] = [];
    const catalog: Pick<BoatNativeCatalogService, "reconcile"> = {
      reconcile: (input) => {
        calls.push(input);
        return Effect.succeed(
          input.after === undefined
            ? {
                entries: [
                  { id: "uncertain", outcome: "obligation", code: "native-outcome-unknown" },
                ],
                next: "cursor-1",
              }
            : { entries: [{ id: "settled", outcome: "updated", code: "adopted" }] },
        );
      },
    };
    const first = await Effect.runPromise(reconcileNativePublications({ catalog, limit: 1000 }));
    expect(first.entries).toEqual([
      { id: "uncertain", outcome: "obligation", code: "native-outcome-unknown" },
    ]);
    if (first.next === undefined) throw new Error("Expected continuation cursor.");
    const second = await Effect.runPromise(
      reconcileNativePublications({ catalog, limit: 0, after: first.next }),
    );
    expect(calls).toEqual([{ limit: 100 }, { limit: 1, after: "cursor-1" }]);
    expect(second.entries).toEqual([{ id: "settled", outcome: "updated", code: "adopted" }]);
    expect(second.next).toBeUndefined();
  });
});
