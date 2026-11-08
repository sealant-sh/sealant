import { randomUUID } from "node:crypto";

import { nativeArtifactConsumerSchema } from "@sealant/validators";
import { describe, expect, it } from "vitest";

describe("native publication workspace-attempt consumer", () => {
  it.each(["14e17eee-ea8f-4687-9c1a-65cf7eee526b", randomUUID()])(
    "reads the attempt UUID and its runtime-instance key, including serialized ledger data: %s",
    (runId) => {
      const stored: unknown = JSON.parse(JSON.stringify({ runId, runtimeInstanceId: runId }));
      expect(nativeArtifactConsumerSchema.parse(stored)).toEqual({
        runId,
        runtimeInstanceId: runId,
      });
    },
  );

  it("refuses a different instance even when both IDs are valid attempt UUIDs", () => {
    expect(
      nativeArtifactConsumerSchema.safeParse({
        runId: randomUUID(),
        runtimeInstanceId: randomUUID(),
      }).success,
    ).toBe(false);
  });

  it.each([`run_${randomUUID()}`, "attempt-a", "", "not-a-uuid"])(
    "refuses a conversation run key or malformed attempt key: %s",
    (runId) => {
      expect(
        nativeArtifactConsumerSchema.safeParse({ runId, runtimeInstanceId: runId }).success,
      ).toBe(false);
    },
  );
});
