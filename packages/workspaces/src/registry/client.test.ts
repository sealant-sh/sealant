import { describe, expect, it, vi } from "vitest";

import {
  createZotRegistryClient,
  RegistryClientHttpError,
  RegistryNameError,
  RegistryResponseTooLargeError,
} from "./client.js";

/** A client under a path prefix whose fetch must stay untouched by a refused name. */
const neverFetched = () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  const client = createZotRegistryClient({
    baseUrl: "http://127.0.0.1:5000/registry",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
};

describe("ZotRegistryClient", () => {
  it("pings the OCI API root", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const client = createZotRegistryClient({
      baseUrl: "http://127.0.0.1:5000",
      fetch: fetchMock as typeof fetch,
    });

    await client.ping();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];

    expect(requestUrl.toString()).toBe("http://127.0.0.1:5000/v2/");
    expect(requestInit).toMatchObject({
      method: "GET",
      headers: new Headers(),
      // A 3xx is an answer, never a destination; every request carries a deadline.
      redirect: "manual",
    });
    expect(requestInit.signal).toBeInstanceOf(AbortSignal);
  });

  it("deletes a manifest by digest and treats an absent one as missing", async () => {
    const fetchMock = vi.fn(async (url: URL) =>
      url
        .toString()
        .endsWith("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 202 }),
    );
    const commandRunner = vi.fn(async (_command: string, _args: Array<string>) => {
      throw new Error("Error: No such image");
    });
    const client = createZotRegistryClient({
      baseUrl: "http://127.0.0.1:5000",
      fetch: fetchMock as unknown as typeof fetch,
      commandRunner,
    });

    await expect(
      client.deleteImage({
        repository: "sealant-workspace-arch",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).resolves.toBe("deleted");
    // The worker's own Engine copy goes too, and its absence is not a failure.
    expect(commandRunner).toHaveBeenCalledWith("docker", [
      "image",
      "rm",
      "-f",
      "127.0.0.1:5000/sealant-workspace-arch@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    await expect(
      client.deleteImage({
        repository: "sealant-workspace-arch",
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).resolves.toBe("missing");

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(requestUrl.toString()).toBe(
      "http://127.0.0.1:5000/v2/sealant-workspace-arch/manifests/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(requestInit.method).toBe("DELETE");
  });

  it("surfaces a registry that refuses deletes", async () => {
    const client = createZotRegistryClient({
      baseUrl: "http://127.0.0.1:5000",
      fetch: vi.fn(async () => new Response("deletes disabled", { status: 405 })) as typeof fetch,
      commandRunner: vi.fn(async () => ({ stdout: "", stderr: "" })),
    });

    await expect(
      client.deleteImage({
        repository: "sealant-workspace-arch",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).rejects.toBeInstanceOf(RegistryClientHttpError);
  });

  it("treats a missing repository as absent", async () => {
    const client = createZotRegistryClient({
      baseUrl: "http://127.0.0.1:5000",
      fetch: vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch,
    });

    await expect(client.repositoryExists("missing/repo")).resolves.toBe(false);
    await expect(client.listTags("missing/repo")).resolves.toEqual([]);
  });

  it("lists tags for an existing repository", async () => {
    const client = createZotRegistryClient({
      baseUrl: "http://127.0.0.1:5000",
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ tags: ["latest", "opencode"] }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
      ) as typeof fetch,
    });

    await expect(client.listTags("sealant/workspace")).resolves.toEqual(["latest", "opencode"]);
  });

  it("discovers enabled extensions", async () => {
    const client = createZotRegistryClient({
      baseUrl: "http://127.0.0.1:5000",
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              extensions: [
                {
                  name: "_zot",
                  url: "https://example.test/_zot.md",
                  description: "zot registry extensions",
                  endpoints: ["/v2/_zot/ext/search"],
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
      ) as typeof fetch,
    });

    await expect(client.discoverExtensions()).resolves.toEqual([
      {
        name: "_zot",
        url: "https://example.test/_zot.md",
        description: "zot registry extensions",
        endpoints: ["/v2/_zot/ext/search"],
      },
    ]);
  });

  it("publishes a docker-loadable image archive to the registry", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "docker-content-digest": "sha256:published-digest",
          },
        });
      }

      return new Response(null, { status: 200 });
    });

    const commandRunner = vi
      .fn(async (_command: string, _args: Array<string>) => ({
        stdout: "",
        stderr: "",
      }))
      .mockResolvedValueOnce({
        stdout: "Loaded image: sealant-workspace-opencode:opencode\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: "latest: digest: sha256:published-digest size: 1234\n",
        stderr: "",
      });

    const client = createZotRegistryClient({
      baseUrl: "http://zot:5000",
      pushRegistry: "127.0.0.1:5000",
      fetch: fetchMock as typeof fetch,
      commandRunner: commandRunner as NonNullable<
        Parameters<typeof createZotRegistryClient>[0]["commandRunner"]
      >,
    });

    await expect(
      client.publishOciImage({
        artifactPath: "/tmp/workspace-image.tar",
        repository: "sealant/workspaces/demo",
        tag: "opencode",
      }),
    ).resolves.toEqual({
      repository: "sealant/workspaces/demo",
      tag: "opencode",
      reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
      digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:published-digest",
      digest: "sha256:published-digest",
    });

    expect(commandRunner).toHaveBeenNthCalledWith(1, "docker", [
      "load",
      "-i",
      "/tmp/workspace-image.tar",
    ]);
    expect(commandRunner).toHaveBeenNthCalledWith(2, "docker", [
      "tag",
      "sealant-workspace-opencode:opencode",
      "127.0.0.1:5000/sealant/workspaces/demo:opencode",
    ]);
    expect(commandRunner).toHaveBeenNthCalledWith(3, "docker", [
      "push",
      "127.0.0.1:5000/sealant/workspaces/demo:opencode",
    ]);
  });

  it("raises a typed HTTP error for unexpected failures", async () => {
    const client = createZotRegistryClient({
      baseUrl: "http://127.0.0.1:5000",
      fetch: vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch,
    });

    await expect(client.ping()).rejects.toBeInstanceOf(RegistryClientHttpError);
  });

  describe("names are refused, never repaired (CORE-08)", () => {
    it.each([
      "../_catalog",
      "a/../../_catalog",
      "a/./b",
      "a//b",
      "a/%2e%2e/b",
      "a%2fb",
      "a?x=1",
      "a#frag",
      "a\\b",
      "http://evil.example/x",
      "Upper/case",
      "a b",
      "a/b:tag",
      `${"a".repeat(256)}`,
    ])("refuses repository %j without a request", async (repository) => {
      const { client, fetchMock } = neverFetched();
      await expect(client.listTags(repository)).rejects.toBeInstanceOf(RegistryNameError);
      await expect(client.getManifest(repository, "latest")).rejects.toBeInstanceOf(
        RegistryNameError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      "../../_catalog",
      "latest/../../x",
      "a?b",
      "a#b",
      ".hidden",
      "-dash",
      "%2e%2e",
      "sha256:short",
      `sha256:${"g".repeat(64)}`,
      "x".repeat(129),
      "",
    ])("refuses reference %j without a request", async (reference) => {
      const { client, fetchMock } = neverFetched();
      await expect(client.getManifest("sealant/ws", reference)).rejects.toBeInstanceOf(
        RegistryNameError,
      );
      await expect(client.headManifest("sealant/ws", reference)).rejects.toBeInstanceOf(
        RegistryNameError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a digest that is not one before deleting or touching docker", async () => {
      const { client, fetchMock } = neverFetched();
      await expect(
        client.deleteImage({ repository: "sealant/ws", digest: "sha256:x/../../y" }),
      ).rejects.toBeInstanceOf(RegistryNameError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reads surrounding slashes as spelling, so a scheme-relative form stays a repository", async () => {
      const { client, fetchMock } = neverFetched();
      await client.listTags("//evil.example/x");
      const [requestUrl] = fetchMock.mock.calls[0] as unknown as [URL];
      expect(requestUrl.toString()).toBe(
        "http://127.0.0.1:5000/registry/v2/evil.example/x/tags/list",
      );
    });

    it("keeps valid names under the registry's own /v2/ path", async () => {
      const { client, fetchMock } = neverFetched();
      await client.getManifest("/sealant/ws-1.arch__x/", `sha256:${"a".repeat(64)}`);
      const [requestUrl] = fetchMock.mock.calls[0] as unknown as [URL];
      expect(requestUrl.toString()).toBe(
        `http://127.0.0.1:5000/registry/v2/sealant/ws-1.arch__x/manifests/sha256:${"a".repeat(64)}`,
      );
    });
  });

  describe("answers are bounded", () => {
    it("reports a redirect as a failed status instead of following it", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(null, { status: 307, headers: { location: "http://169.254.169.254/" } }),
      );
      const client = createZotRegistryClient({
        baseUrl: "http://127.0.0.1:5000",
        fetch: fetchMock as unknown as typeof fetch,
      });
      await expect(client.listTags("sealant/ws")).rejects.toMatchObject({ status: 307 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refuses a body over the limit by its declared length", async () => {
      const client = createZotRegistryClient({
        baseUrl: "http://127.0.0.1:5000",
        maxResponseBytes: 16,
        fetch: (async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": "1000000" },
          })) as unknown as typeof fetch,
      });
      await expect(client.listTags("sealant/ws")).rejects.toBeInstanceOf(
        RegistryResponseTooLargeError,
      );
    });

    it("stops reading a body that outgrows the limit while streaming", async () => {
      let pulled = 0;
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(8));
        },
      });
      const client = createZotRegistryClient({
        baseUrl: "http://127.0.0.1:5000",
        maxResponseBytes: 64,
        fetch: (async () => new Response(endless, { status: 200 })) as unknown as typeof fetch,
      });
      await expect(client.listTags("sealant/ws")).rejects.toBeInstanceOf(
        RegistryResponseTooLargeError,
      );
      expect(pulled).toBeLessThan(32);
    });

    it("gives up on a registry that never answers", async () => {
      const client = createZotRegistryClient({
        baseUrl: "http://127.0.0.1:5000",
        requestTimeoutMs: 20,
        fetch: ((_url: URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          })) as unknown as typeof fetch,
      });
      await expect(client.ping()).rejects.toMatchObject({ name: "TimeoutError" });
    });
  });
});
