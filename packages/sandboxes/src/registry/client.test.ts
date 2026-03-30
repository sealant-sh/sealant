import { describe, expect, it, vi } from "vitest";

import { createZotRegistryClient, RegistryClientHttpError } from "./client.js";

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
    expect(requestInit).toEqual({
      method: "GET",
      headers: new Headers(),
    });
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

    await expect(client.listTags("sealant/sandbox")).resolves.toEqual(["latest", "opencode"]);
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
        stdout: "Loaded image: sealant-sandbox-opencode:opencode\n",
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
        artifactPath: "/tmp/sandbox-image.tar",
        repository: "sealant/sandboxes/demo",
        tag: "opencode",
      }),
    ).resolves.toEqual({
      repository: "sealant/sandboxes/demo",
      tag: "opencode",
      reference: "127.0.0.1:5000/sealant/sandboxes/demo:opencode",
      digestReference: "127.0.0.1:5000/sealant/sandboxes/demo@sha256:published-digest",
      digest: "sha256:published-digest",
    });

    expect(commandRunner).toHaveBeenNthCalledWith(1, "docker", [
      "load",
      "-i",
      "/tmp/sandbox-image.tar",
    ]);
    expect(commandRunner).toHaveBeenNthCalledWith(2, "docker", [
      "tag",
      "sealant-sandbox-opencode:opencode",
      "127.0.0.1:5000/sealant/sandboxes/demo:opencode",
    ]);
    expect(commandRunner).toHaveBeenNthCalledWith(3, "docker", [
      "push",
      "127.0.0.1:5000/sealant/sandboxes/demo:opencode",
    ]);
  });

  it("raises a typed HTTP error for unexpected failures", async () => {
    const client = createZotRegistryClient({
      baseUrl: "http://127.0.0.1:5000",
      fetch: vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch,
    });

    await expect(client.ping()).rejects.toBeInstanceOf(RegistryClientHttpError);
  });
});
