import { describe, expect, it } from "vitest";
import { z } from "zod";

import { boatLaunchSupport, boatSupport } from "./boat-support.js";
import { runtimeAdapterIds, type RuntimeAdapterId } from "./runtime-adapter-ids.js";
import {
  runtimeRefusal,
  runtimeSupport,
  type RuntimeCapability,
  type RuntimeInstall,
  type RuntimeRequest,
  type RuntimeRequirement,
  type RuntimeSupport,
} from "./runtime-support.js";
import { parseWorkspaceBlueprint } from "./workspace-blueprint.js";

const capture = {
  kind: "capture",
  endpoint: "https://mend.example.com/session/s1",
  worktreeId: "wt_1",
  harnessHome: "/workspace/harness-home",
} as const;

/** A request that asks nothing of any runtime but what the case adds. */
const base = (): RuntimeRequest =>
  parseWorkspaceBlueprint({ sources: { workspace: capture }, harness: { id: "claude-code" } });

const withSpec = (spec: Record<string, unknown>): RuntimeRequest =>
  parseWorkspaceBlueprint({
    harness: { id: "claude-code" },
    ...spec,
    sources: {
      workspace: capture,
      ...z.record(z.string(), z.unknown()).optional().parse(spec["sources"]),
    },
  });

const BROKERED = {
  secretId: "psec_1",
  name: "VERCEL_TOKEN",
  placeholder: "mend_sec_0123456789abcdef",
  secretRef: "ref-1",
  headerName: "Authorization",
  bindHosts: ["api.vercel.com"],
};

const policyOf = (support: RuntimeSupport) => {
  if (support.networkPolicy === undefined) throw new Error("the table reports no network policy");
  return support.networkPolicy;
};

/**
 * Every way a request asks for one item of the table: the item it asks and the request. A
 * request asks for nothing else (a capture source, the default family, runc, no Docker).
 */
const ASKS: ReadonlyArray<{
  readonly name: string;
  readonly item: (support: RuntimeSupport) => RuntimeCapability;
  readonly requirement: RuntimeRequirement;
  readonly request: RuntimeRequest;
}> = [
  ...(["ubuntu", "nix", "arch", "fedora"] as const).map((family) => ({
    name: `${family} family`,
    item: (support: RuntimeSupport) => support.os[family],
    requirement: "os" as const,
    request: withSpec({ target: { os: { family } } }),
  })),
  {
    name: "custom base image",
    item: (support) => support.customImage,
    requirement: "customImage",
    request: withSpec({ target: { os: { family: "custom", baseImage: "ubuntu:24.04" } } }),
  },
  {
    name: "gVisor",
    item: (support) => support.gvisor,
    requirement: "gvisor",
    request: withSpec({ runtime: { ociRuntime: "runsc", network: { cloudMetadata: true } } }),
  },
  {
    name: "mount source",
    item: (support) => support.hostDirectories,
    requirement: "hostDirectories",
    request: parseWorkspaceBlueprint({
      sources: { workspace: { kind: "mount", hostPath: "/srv/work" } },
      harness: { id: "claude-code" },
    }),
  },
  {
    name: "extra host mount",
    item: (support) => support.hostDirectories,
    requirement: "hostDirectories",
    request: withSpec({ sources: { mounts: [{ hostPath: "/srv/ref", mountPath: "/ref" }] } }),
  },
  {
    name: "Kubernetes Secret",
    item: (support) => support.clusterEnv,
    requirement: "clusterEnv",
    request: withSpec({ runtime: { envFrom: [{ kind: "secret", name: "app-env" }] } }),
  },
  {
    name: "Kubernetes service account",
    item: (support) => support.clusterEnv,
    requirement: "clusterEnv",
    request: withSpec({ runtime: { kubernetes: { serviceAccountName: "dev-sa" } } }),
  },
  {
    name: "git source",
    item: (support) => support.gitSource,
    requirement: "gitSource",
    request: parseWorkspaceBlueprint({
      sources: { workspace: { kind: "git", url: "https://github.com/acme/app.git" } },
      harness: { id: "claude-code" },
    }),
  },
  {
    name: "dotfiles archive",
    item: (support) => support.dotfilesArchives,
    requirement: "dotfilesArchives",
    request: withSpec({ runtime: { dotfilesArchives: [{ data: "aGVsbG8=" }] } }),
  },
  {
    name: "Docker inside",
    item: (support) => support.docker,
    requirement: "docker",
    request: withSpec({ tooling: { services: { docker: { enabled: true } } } }),
  },
  {
    name: "VM isolation",
    item: (support) => policyOf(support).vmIsolation,
    requirement: "vmIsolation",
    request: withSpec({
      networkPolicy: { mode: "standard", policyHash: "h", requireVmIsolation: true },
    }),
  },
  {
    name: "restricted egress",
    item: (support) => policyOf(support).restricted,
    requirement: "restrictedEgress",
    request: withSpec({ networkPolicy: { mode: "restricted", policyHash: "h" } }),
  },
  {
    name: "a brokered secret under standard egress",
    item: (support) => policyOf(support).brokeredSecrets,
    requirement: "brokeredSecrets",
    request: withSpec({ brokeredSecrets: [BROKERED] }),
  },
];

const install = (overrides: Partial<RuntimeInstall> = {}): RuntimeInstall => ({
  kubernetesDocker: false,
  microvmDocker: false,
  microvmAgentPort: 8080,
  containerArchitecture: "x86_64",
  resourceHost: "docker",
  ...overrides,
});

const INSTALLS: readonly RuntimeInstall[] = [
  install(),
  install({ kubernetesDocker: true, microvmDocker: true, containerArchitecture: "aarch64" }),
  install({ resourceHost: "kubernetes" }),
  install({ resourceHost: "none" }),
];

describe("runtimeRefusal over the runtime table", () => {
  it("asks nothing of any runtime for a plain capture workspace", () => {
    for (const runtime of runtimeAdapterIds)
      for (const each of INSTALLS)
        expect(runtimeRefusal(runtimeSupport(runtime, each), base())).toBeUndefined();
  });

  for (const runtime of runtimeAdapterIds)
    for (const ask of ASKS)
      it(`${runtime}: refuses ${ask.name} exactly where the table marks it unsupported`, () => {
        for (const each of INSTALLS) {
          const support = runtimeSupport(runtime, each);
          const item = ask.item(support);
          const refusal = runtimeRefusal(support, ask.request);
          if (item.supported) {
            expect(refusal).toBeUndefined();
            continue;
          }
          expect(refusal).toBeDefined();
          // The refusal reads the table's sentence; cluster references add the names asked.
          if (refusal?.code === "runtime-env-references-unsupported")
            expect(refusal.message.startsWith(`${item.message} This workspace names `)).toBe(true);
          else expect(refusal?.message).toBe(item.message);
          expect(refusal?.code).toBe(
            ask.requirement === "os"
              ? "runtime-os-unsupported"
              : ask.requirement === "docker"
                ? "workspace-docker-unsupported"
                : ask.requirement === "clusterEnv" && runtime !== "boat"
                  ? "runtime-env-references-unsupported"
                  : "runtime-requirement-unsupported",
          );
        }
      });

  it("names every cluster reference a request gave", () => {
    const refusal = runtimeRefusal(
      runtimeSupport("docker", install()),
      withSpec({
        runtime: {
          envFrom: [
            { kind: "secret", name: "app-env" },
            { kind: "configmap", name: "app-config" },
          ],
          kubernetes: { serviceAccountName: "dev-sa" },
        },
      }),
    );
    expect(refusal?.message).toContain(
      "This workspace names secret/app-env, configmap/app-config, serviceAccount dev-sa.",
    );
  });

  it("refuses the first unsupported item in create order", () => {
    // Arch before the git source before Docker (which Boat serves).
    const refusal = runtimeRefusal(
      runtimeSupport("boat", install()),
      parseWorkspaceBlueprint({
        sources: { workspace: { kind: "git", url: "https://github.com/acme/app.git" } },
        harness: { id: "claude-code" },
        target: { os: { family: "arch" } },
        tooling: { services: { docker: { enabled: true } } },
      }),
    );
    expect(refusal?.code).toBe("runtime-os-unsupported");
  });
});

/** The items of a runtime's row that it marks unsupported. */
const unsupported = (runtime: RuntimeAdapterId, each: RuntimeInstall = install()) => {
  const support = runtimeSupport(runtime, each);
  return Object.entries({
    ...Object.fromEntries(Object.entries(support.os).map(([key, value]) => [`os.${key}`, value])),
    customImage: support.customImage,
    hostDirectories: support.hostDirectories,
    docker: support.docker,
    gvisor: support.gvisor,
    clusterEnv: support.clusterEnv,
    gitSource: support.gitSource,
    dotfilesArchives: support.dotfilesArchives,
  })
    .filter(([, value]) => !value.supported)
    .map(([key]) => key);
};

describe("the runtime table", () => {
  it("pins what each runtime refuses", () => {
    expect(unsupported("docker")).toEqual(["clusterEnv"]);
    expect(unsupported("k8s")).toEqual(["docker"]);
    expect(unsupported("k8s", install({ kubernetesDocker: true }))).toEqual([]);
    expect(unsupported("k3s")).toEqual(["docker"]);
    expect(unsupported("microvm")).toEqual(["hostDirectories", "docker", "gvisor", "clusterEnv"]);
    expect(unsupported("microvm", install({ microvmDocker: true }))).toEqual([
      "hostDirectories",
      "gvisor",
      "clusterEnv",
    ]);
    expect(unsupported("cloudflare")).toEqual([
      "hostDirectories",
      "docker",
      "gvisor",
      "clusterEnv",
    ]);
    expect(unsupported("host-vm")).toEqual(["hostDirectories", "gvisor", "clusterEnv"]);
    expect(unsupported("boat")).toEqual([
      "os.arch",
      "os.fedora",
      "customImage",
      "hostDirectories",
      "gvisor",
      "clusterEnv",
      "gitSource",
      "dotfilesArchives",
    ]);
  });

  it("pins Boat's sentences, which released SDK callers have read", () => {
    const boat = runtimeSupport("boat", install());
    expect(boat.os.arch).toEqual({
      supported: false,
      message: "Boat supports Ubuntu and Nix; Arch is unsupported.",
    });
    expect(boat.customImage).toMatchObject({
      message: "Boat cannot boot a custom OCI base image.",
    });
    expect(boat.gvisor).toMatchObject({ message: "Boat cannot supply the runsc OCI runtime." });
    expect(boat.clusterEnv).toMatchObject({
      message: "Boat cannot resolve Kubernetes environment references.",
    });
    expect(boat.reservedPorts).toEqual([8080]);
    expect(boat.screen).toEqual({ supported: true, architectures: ["x86_64"] });
    expect(boat.idleCost.charged).toBe(true);
  });

  it("answers ports, screens, resources and idle cost from the install", () => {
    const arm = install({ containerArchitecture: "aarch64", microvmAgentPort: 9090 });
    expect(runtimeSupport("docker", arm).screen).toEqual({
      supported: true,
      architectures: ["aarch64"],
    });
    expect(runtimeSupport("microvm", arm).reservedPorts).toEqual([9090]);
    expect(runtimeSupport("k8s", arm).reservedPorts).toEqual([7443]);
    expect(runtimeSupport("docker", arm).idleCost.charged).toBe(false);
    expect(runtimeSupport("docker", install()).resources).toEqual({
      supported: true,
      attach: "live",
    });
    expect(runtimeSupport("boat", install()).resources).toEqual({
      supported: true,
      attach: "live",
    });
    expect(runtimeSupport("boat", install({ resourceHost: "none" })).resources.supported).toBe(
      false,
    );
    // Boat reaches resources only through a launching worker's gateway.
    expect(runtimeSupport("boat", install({ boatGateway: false })).resources.supported).toBe(false);
    expect(runtimeSupport("boat", install({ boatGateway: true })).resources).toEqual({
      supported: true,
      attach: "live",
    });
    expect(runtimeSupport("k8s", install({ resourceHost: "kubernetes" })).resources.supported).toBe(
      false,
    );
    expect(runtimeSupport("microvm", install({ resourceHost: "none" })).resources.supported).toBe(
      false,
    );
  });
});

describe("network policy admission (fail closed, never downgraded)", () => {
  const enforced = (runtime: RuntimeAdapterId) =>
    Object.entries(policyOf(runtimeSupport(runtime, install())))
      .filter(([, value]) => value.supported)
      .map(([key]) => key);

  it("pins what each runtime enforces of a policy", () => {
    expect(enforced("host-vm")).toEqual([
      "vmIsolation",
      "restricted",
      "restrictedWithDocker",
      "brokeredSecrets",
    ]);
    expect(enforced("docker")).toEqual(["restricted", "brokeredSecrets"]);
    expect(enforced("boat")).toEqual(["vmIsolation"]);
    expect(enforced("microvm")).toEqual(["vmIsolation"]);
    for (const runtime of ["k8s", "k3s", "cloudflare"] as const)
      expect(enforced(runtime)).toEqual([]);
  });

  it("refuses restricted egress with Docker inside a Docker workspace, and tells the owner what to switch to", () => {
    const refusal = runtimeRefusal(
      runtimeSupport("docker", install()),
      withSpec({
        networkPolicy: { mode: "restricted", policyHash: "h" },
        tooling: { services: { docker: { enabled: true } } },
      }),
    );
    expect(refusal?.code).toBe("runtime-requirement-unsupported");
    expect(refusal?.detail).toBe("network-policy-restricted-unsupported");
    expect(refusal?.message).toContain("host-vm");
    expect(
      runtimeRefusal(
        runtimeSupport("host-vm", install()),
        withSpec({
          networkPolicy: { mode: "restricted", policyHash: "h" },
          tooling: { services: { docker: { enabled: true } } },
        }),
      ),
    ).toBeUndefined();
  });

  it("tells a Docker owner to switch the runtime to host-vm for VM isolation", () => {
    const refusal = runtimeRefusal(
      runtimeSupport("docker", install()),
      withSpec({ networkPolicy: { mode: "standard", policyHash: "h", requireVmIsolation: true } }),
    );
    expect(refusal?.message).toContain("Switch the runtime to Host VM (host-vm)");
  });

  it("refuses a policy on a runtime whose control plane reported none", () => {
    const { networkPolicy: _omitted, ...older } = runtimeSupport("docker", install());
    expect(runtimeRefusal(older, withSpec({ brokeredSecrets: [BROKERED] }))?.detail).toBe(
      "network-policy-brokered-secrets-unsupported",
    );
  });

  it("refuses a brokered secret whose variable the spec also sets", () => {
    expect(() =>
      withSpec({
        brokeredSecrets: [BROKERED],
        runtime: { userEnv: { VERCEL_TOKEN: "x" } },
      }),
    ).toThrow(/also set in runtime.env or runtime.userEnv/);
  });
});

describe("boatSupport and boatLaunchSupport", () => {
  const git = parseWorkspaceBlueprint({
    sources: { workspace: { kind: "git", url: "https://github.com/acme/app.git" } },
    harness: { id: "claude-code" },
  });
  const archives = parseWorkspaceBlueprint({
    sources: { workspace: capture },
    harness: { id: "claude-code" },
    runtime: { dotfilesArchives: [{ data: "aGVsbG8=" }] },
  });

  it("leaves the source and dotfiles to the launch: an image is the same for either", () => {
    expect(boatSupport(git)).toEqual({ supported: true });
    expect(boatSupport(archives)).toEqual({ supported: true });
  });

  it("refuses a git source and dotfiles archives at launch, with the table's sentences", () => {
    const boat = runtimeSupport("boat", install());
    expect(boatLaunchSupport(git)).toEqual({
      supported: false,
      reason: "runtime-requirement-unsupported",
      detail: "native-capture-source-required",
      message: boat.gitSource.supported ? "" : boat.gitSource.message,
    });
    expect(boatLaunchSupport(archives)).toMatchObject({
      supported: false,
      reason: "runtime-requirement-unsupported",
      detail: "native-dotfiles-archives-unsupported",
    });
  });

  it("keeps the image builder's detail codes", () => {
    expect(
      boatSupport(
        parseWorkspaceBlueprint({
          sources: { workspace: capture },
          harness: { id: "claude-code" },
          target: { os: { family: "fedora" } },
        }),
      ),
    ).toMatchObject({ reason: "runtime-os-unsupported", detail: "native-unsupported-os" });
  });
});
