/**
 * The in-request exec is on no route yet. This holds its wiring to the API's real request layers
 * at compile time: a service it needs that `requestDependenciesLayer` does not provide is a type
 * error naming that service. Type-only imports: the server module never runs here.
 */
import type { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import type { requestDependenciesLayer } from "../../index.js";
import type { execWorkspaceInRequest } from "./workspaces.module.js";

type Needed = Effect.Services<ReturnType<typeof execWorkspaceInRequest>>;
type Unprovided = Exclude<Needed, Layer.Success<typeof requestDependenciesLayer>>;

const unprovided: [Unprovided] extends [never] ? "none" : Unprovided = "none";

describe("the in-request exec's wiring", () => {
  it("needs no service the API's request layers lack", () => {
    expect(unprovided).toBe("none");
  });
});
