/**
 * A Boat key that the control plane refuses is never echoed by the client: whatever its shape, it
 * goes on the wire as given and the error names it nowhere. Driven against a stubbed `fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a Boat key in an error", () => {
  it("sends a key with stray whitespace as it is, and never puts it in an error", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        sent.push(JSON.parse(await request.text()));
        return new Response(
          JSON.stringify({
            _tag: "BoatAccountBadRequestError",
            message: "apiKey is not a Boat API key.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });
    const key = "fixture-boat-key-from-a-file\n";
    const error: unknown = await sealant.boatAccounts
      .create({ label: "Organization A", apiKey: key })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain("fixture-boat-key-from-a-file");
    expect(error instanceof Error ? error.message : "").not.toContain(
      "fixture-boat-key-from-a-file",
    );
    // The control plane, not the client, decides the key is malformed.
    expect(sent).toEqual([{ label: "Organization A", apiKey: key }]);
    await sealant.close();
  });
});
