/**
 * A Boat workspace that failed because Boat refused a call: `ready()` rejects with
 * `SealantBoatError`, whose `boat` says why (the kind, Boat's code, message and request id). Any
 * other failed workspace rejects as before. Driven over real HTTP against a stub control plane.
 */
import { createServer } from "node:http";

import type { BoatFailure } from "@sealant/api-contracts";
import { describe, expect, it } from "vitest";

import { BOAT_FAILURE_KINDS, Sealant, SealantBoatError, SealantError } from "./index.js";

const serve = async (error: { message: string; code?: string; boat?: BoatFailure }) => {
  const server = createServer((request, response) => {
    response.writeHead(request.url?.startsWith("/v1/workspaces/ws_boat") === true ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify({
        workspaceId: "ws_boat",
        name: "boat",
        ownerUserId: "usr_owner",
        status: "failed",
        error,
        createdAt: "2026-11-13T00:00:00.000Z",
        updatedAt: "2026-11-13T00:00:00.000Z",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
  const client = new Sealant({
    baseUrl: `http://127.0.0.1:${address.port}`,
    ownerUserId: "usr_owner",
  });
  return {
    ready: async () => (await client.workspaces.get("ws_boat")).ready(),
    close: async () => {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

describe("a Boat refusal through ready()", () => {
  it.each(BOAT_FAILURE_KINDS)(
    "%s reaches the caller with Boat's code and request id",
    async (kind) => {
      const boat: BoatFailure = {
        kind,
        retryable: ["rate-limited", "no-machine", "no-answer"].includes(kind),
        operation: "create",
        status: 403,
        code: "api_key_expired",
        message: "API key expired.",
        requestId: "req_0123456789",
      };
      const f = await serve({
        message: "Boat runtime: launch-held; diagnostic {}",
        code: "launch-held",
        boat,
      });
      try {
        const error: unknown = await f.ready().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(SealantBoatError);
        if (!(error instanceof SealantBoatError)) return;
        expect(error.boat).toEqual(boat);
        expect(error.code).toBe("workspace_not_ready");
      } finally {
        await f.close();
      }
    },
  );

  it("keeps Boat's wait and billing link, and any other failure stays a SealantError", async () => {
    const boat: BoatFailure = {
      kind: "billing-required",
      retryable: false,
      status: 402,
      code: "billing_required",
      requestId: "req_abc",
      billingUrl: "https://boat.dev/billing?from=api",
    };
    const billed = await serve({ message: "Native snapshot failed", boat });
    try {
      const error: unknown = await billed.ready().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ boat: { billingUrl: "https://boat.dev/billing?from=api" } });
    } finally {
      await billed.close();
    }
    const other = await serve({ message: "Docker refused", code: "runtime-exited" });
    try {
      const error: unknown = await other.ready().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SealantError);
      expect(error).not.toBeInstanceOf(SealantBoatError);
    } finally {
      await other.close();
    }
  });
});
