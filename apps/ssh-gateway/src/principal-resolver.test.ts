import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrincipalResolver } from "./principal-resolver.js";

const offeredKey = {
  algo: "ssh-ed25519",
  data: Buffer.from("test-key-blob"),
};

const resolverConfig = {
  apiBaseUrl: "http://127.0.0.1:4000",
  gatewayToken: "test-gateway-token",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPrincipalResolver", () => {
  it("maps a 200 response to found with the principal id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          principalId: "usr_local",
          sshKeyId: "sshk_1",
          fingerprint: "SHA256:abc",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const resolve = createPrincipalResolver(resolverConfig);
    const result = await resolve(offeredKey);

    expect(result).toEqual({ kind: "found", principalId: "usr_local" });

    // The gateway token and the offered key blob must reach the API verbatim.
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:4000/v1/ssh-keys/resolve-principal");
    expect((init.headers as Record<string, string>)["x-sealant-gateway-token"]).toBe(
      "test-gateway-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      algo: "ssh-ed25519",
      publicKeyBase64: offeredKey.data.toString("base64"),
    });
  });

  it("maps a 404 to not-found (definitive unknown key, not an error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "nope" }), { status: 404 })),
    );

    const resolve = createPrincipalResolver(resolverConfig);

    expect(await resolve(offeredKey)).toEqual({ kind: "not-found" });
  });

  it("maps a 5xx to error, never not-found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 503 })));

    const resolve = createPrincipalResolver(resolverConfig);
    const result = await resolve(offeredKey);

    expect(result.kind).toBe("error");
  });

  it("maps a network failure to error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    const resolve = createPrincipalResolver(resolverConfig);
    const result = await resolve(offeredKey);

    expect(result).toEqual({ kind: "error", message: "connect ECONNREFUSED" });
  });

  it("maps a malformed 200 body to error (contract drift fails loudly)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ wrong: "shape" }), { status: 200 })),
    );

    const resolve = createPrincipalResolver(resolverConfig);
    const result = await resolve(offeredKey);

    expect(result.kind).toBe("error");
  });
});
