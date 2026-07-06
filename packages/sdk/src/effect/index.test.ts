import * as effectSubpath from "@sealant/sdk/effect";
/**
 * Guards the `@sealant/sdk/effect` subpath: imports go through the package `exports` map (self-
 * reference), not a relative path, so this fails if the subpath wiring breaks — the exact regression
 * that shipped 0.4.0 with the Effect core present in `dist/` but unaddressable.
 */
import { describe, expect, it } from "vitest";

describe("@sealant/sdk/effect subpath", () => {
  it("exposes the client service, layer, runtime, and operations", () => {
    expect(effectSubpath.SealantApiClient).toBeDefined();
    expect(typeof effectSubpath.sealantApiClientLayer).toBe("function");
    expect(typeof effectSubpath.makeSdkRuntime).toBe("function");
    expect(typeof effectSubpath.resolveInternalConfig).toBe("function");
    expect(typeof effectSubpath.createWorkspaceOp).toBe("function");
    expect(typeof effectSubpath.createRunOp).toBe("function");
    expect(typeof effectSubpath.getRunTimelineOp).toBe("function");
  });

  it("exposes the typed contract errors for catchTag matching", async () => {
    const { Effect } = await import("effect");
    const recovered = await Effect.runPromise(
      Effect.fail(new effectSubpath.RunNotFoundError({ message: "gone" })).pipe(
        Effect.catchTag("RunNotFoundError", (error) => Effect.succeed(error.message)),
      ),
    );
    expect(recovered).toBe("gone");
    expect(new effectSubpath.WorkspaceNotFoundError({ message: "gone" })).toBeInstanceOf(Error);
  });
});
