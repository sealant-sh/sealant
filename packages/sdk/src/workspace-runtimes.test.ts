/**
 * `workspaces.runtimes()`: what the control plane answers on `GET /v1/workspaces/runtimes`, as the
 * SDK hands it on, and types a client switches on exhaustively. Driven against a stubbed `fetch`.
 * The control plane's own answers are pinned by `@sealant/validators`' runtime-support tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import type { RuntimeCapability, RuntimeSupport, WorkspaceRuntimeKind } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const yes = { supported: true } as const;

const docker: RuntimeSupport = {
  runtime: "docker",
  os: { ubuntu: yes, nix: yes, arch: yes, fedora: yes },
  customImage: yes,
  hostDirectories: yes,
  docker: yes,
  gvisor: yes,
  clusterEnv: {
    supported: false,
    message:
      "Docker workspaces cannot read Kubernetes Secrets, ConfigMaps or a service account; only Kubernetes workspaces can. Remove them from this workspace.",
  },
  gitSource: yes,
  dotfilesArchives: yes,
  screen: { supported: true, architectures: ["x86_64"] },
  reservedPorts: [],
  resources: { supported: true, attach: "live" },
  idleCost: {
    charged: false,
    message:
      "A Docker workspace runs on this deployment's own servers: sitting idle costs nothing beyond them.",
  },
};

const boat: RuntimeSupport = {
  ...docker,
  runtime: "boat",
  os: {
    ubuntu: yes,
    nix: yes,
    arch: { supported: false, message: "Boat supports Ubuntu and Nix; Arch is unsupported." },
    fedora: { supported: false, message: "Boat supports Ubuntu and Nix; Fedora is unsupported." },
  },
  customImage: { supported: false, message: "Boat cannot boot a custom OCI base image." },
  reservedPorts: [8080],
  idleCost: {
    charged: true,
    message: "Boat bills a workspace by the second while its VM runs, idle or not.",
  },
};

/** What a client shows for one item: the exhaustive switch a TypeScript client writes. */
const describeItem = (item: RuntimeCapability): string => {
  switch (item.supported) {
    case true:
      return "yes";
    case false:
      return item.message;
  }
};

const runtimeLabel = (runtime: WorkspaceRuntimeKind): string => {
  switch (runtime) {
    case "docker":
      return "Docker";
    case "k8s":
    case "k3s":
      return "Kubernetes";
    case "cloudflare":
      return "Cloudflare";
    case "microvm":
      return "MicroVM";
    case "boat":
      return "Boat";
  }
};

const attachLabel = (support: RuntimeSupport): string => {
  if (!support.resources.supported) return support.resources.message;
  switch (support.resources.attach) {
    case "live":
      return "live";
    case "next-start":
      return "next start";
  }
};

describe("workspaces.runtimes", () => {
  it("reads GET /v1/workspaces/runtimes and hands on the table", async () => {
    const answer = {
      default: "docker",
      runtimes: [docker, boat],
    };
    const seen: Array<{ readonly path: string; readonly method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        seen.push({ path: new URL(request.url).pathname, method: request.method });
        return new Response(JSON.stringify(answer), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });
    const runtimes = await sealant.workspaces.runtimes();
    expect(seen).toEqual([{ path: "/v1/workspaces/runtimes", method: "GET" }]);
    expect(runtimes).toEqual(answer);

    expect(runtimes.runtimes.map((each) => runtimeLabel(each.runtime))).toEqual(["Docker", "Boat"]);
    const [, read] = runtimes.runtimes;
    expect(read === undefined ? undefined : describeItem(read.os.fedora)).toBe(
      "Boat supports Ubuntu and Nix; Fedora is unsupported.",
    );
    expect(read === undefined ? undefined : describeItem(read.os.nix)).toBe("yes");
    expect(read?.reservedPorts).toEqual([8080]);
    expect(read === undefined ? undefined : attachLabel(read)).toBe("live");
    await sealant.close();
  });
});
