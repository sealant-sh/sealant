/**
 * Workspace-scoped Docker on Kubernetes, end to end on the kind cluster (design §D5, DinD).
 *
 * Proves what the Docker adapter's `docker-service.e2e.ts` proves — from inside the workspace,
 * `docker run` a nested container and read its stdout — plus the two things the Pod shape adds:
 *
 *   1. the Pod is user-namespaced with the rootless daemon as a sidecar: root inside the
 *      workspace is not root on the node, and the workspace container itself is unprivileged;
 *   2. a port a nested container publishes is reachable at the Pod's loopback AND at the `docker`
 *      name Mend dials for compose-published Services.
 *
 * A git-sourced workspace on purpose: the kind cluster's RWX class is NFS, which cannot be
 * idmap-mounted into a user-namespaced Pod. That constraint is documented in the Kubernetes guide;
 * this suite proves the daemon, not the store.
 *
 * Gated on SEALANT_K8S_E2E=1 with a cluster from `deploy/e2e/kind/up.sh`, AND on the cluster
 * being able to run a user-namespaced Pod at all — probed with a bare `hostUsers: false` Pod
 * before anything else. kind on GitHub-hosted runners cannot (measured 2026-09-03: the 1.32 node
 * image silently ignores `hostUsers`, and on 1.37 the sandbox itself fails with
 * `mounting "sysfs" … operation not permitted` inside the runner's nested containerd), so there
 * the suite skips with a loud note instead of failing on a limitation of the harness. It runs for
 * real against a cluster whose nodes support user namespaces (Talos 1.13 / containerd 2.2 is the
 * reference), which is where the feature is accepted.
 */
import { parseWorkspaceBlueprint } from "@sealant/validators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KubernetesRuntimeAdapter } from "../runtime/kubernetes/adapter.js";
import { createLiveKubernetesApi } from "../runtime/kubernetes/api.js";
import { kubernetesRuntimeConfigSchema } from "../runtime/kubernetes/config.js";
import type { PublishedImage } from "../runtime/runtime-adapter.js";
import type { SealantTarget } from "../sealantd/runtime.js";
import {
  buildWorkspaceImage,
  clientTls,
  E2E_ENABLED,
  forwardedControlChannel,
  kubectl,
  NAMESPACE,
  runIn,
  startRegistryForward,
  type RegistryForward,
} from "./e2e-support.js";

const RUN_ID = `run-e2e-docker-${Date.now().toString(36)}`;
const PROBE_POD = `userns-probe-${Date.now().toString(36)}`;

/**
 * Can this cluster run a user-namespaced Pod? A bare `hostUsers: false` Pod that only sleeps:
 * Ready within the budget means yes; anything else (sandbox creation failing, the field ignored
 * and the uid map left as the host's) means the daemon suite has nothing to prove here.
 */
const probeUserNamespaces = async (): Promise<{ supported: boolean; reason: string }> => {
  const manifest = JSON.stringify({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: PROBE_POD,
      namespace: NAMESPACE,
      labels: { "sealant.sh/e2e-probe": "userns" },
    },
    spec: {
      hostUsers: false,
      restartPolicy: "Never",
      nodeSelector: { "sealant.sh/e2e-role": "workspace" },
      containers: [{ name: "probe", image: "alpine:3.20", command: ["sleep", "120"] }],
    },
  });
  try {
    // `kubectl apply -f -` needs stdin; go through a temp file instead.
    const { writeFile, rm } = await import("node:fs/promises");
    const path = `/tmp/${PROBE_POD}.json`;
    await writeFile(path, manifest);
    try {
      await kubectl("apply", "-f", path);
    } finally {
      await rm(path, { force: true });
    }
    const ready = await kubectl(
      "wait",
      "--for=condition=Ready",
      `pod/${PROBE_POD}`,
      "--timeout=90s",
    ).then(
      () => true,
      () => false,
    );
    if (!ready) {
      const events = await kubectl(
        "get",
        "events",
        "--field-selector",
        `involvedObject.name=${PROBE_POD}`,
        "-o",
        "jsonpath={range .items[*]}{.reason}: {.message}{'\\n'}{end}",
      ).catch(() => "");
      return {
        supported: false,
        reason: `a bare hostUsers:false Pod did not become Ready in 90s${events.trim() === "" ? "" : `:\n${events.trim().slice(0, 600)}`}`,
      };
    }
    const uidMap = (
      await kubectl("exec", PROBE_POD, "--", "cat", "/proc/self/uid_map").catch(() => "")
    ).trim();
    if (/^\s*0\s+0\s+4294967295\s*$/.test(uidMap)) {
      return {
        supported: false,
        reason: "hostUsers:false was ignored — the Pod's uid map is the host's (0 0 4294967295)",
      };
    }
    return { supported: true, reason: `uid map: ${uidMap.replace(/\s+/g, " ")}` };
  } finally {
    await kubectl("delete", "pod", PROBE_POD, "--ignore-not-found", "--wait=false").catch(
      () => undefined,
    );
  }
};

const blueprint = parseWorkspaceBlueprint({
  version: "1",
  sources: {
    workspace: {
      kind: "git",
      provider: "generic",
      url: "https://github.com/octocat/Hello-World.git",
    },
    inputs: [],
    mounts: [],
  },
  harness: { id: "codex" },
  access: { ssh: { enabled: false, listenPort: 2222 } },
  // The service is what this suite is about; the image builder bakes the docker CLI + compose
  // plugin for it, and the adapter adds the sidecar.
  tooling: { packages: [], services: { docker: { enabled: true } } },
  customization: {
    defaultShell: "bash",
    dotfilesManager: "auto",
    dotfilesTarget: "home",
    applyDotfiles: false,
    dotfilesBootstrap: false,
  },
  lifecycle: {
    setup: [],
    startup: { steps: [], foreground: { kind: "command", run: "sleep infinity", shell: "sh" } },
  },
  runtime: {
    env: {},
    workspaceRoot: "/workspace",
    workingDirectory: "/workspace/repo",
    persistence: "ephemeral",
    ociRuntime: "runc",
    network: { outbound: true },
  },
  target: {
    runtime: { family: "k8s", mode: "require" },
    os: { family: "fedora", mode: "require" },
  },
});

describe.skipIf(!E2E_ENABLED)("Kubernetes workspace-scoped Docker", () => {
  let adapter: KubernetesRuntimeAdapter;
  let publishedImage: PublishedImage;
  let target: SealantTarget | undefined;
  let podName = "";
  let registryForward: RegistryForward | undefined;
  let userNamespaces: { supported: boolean; reason: string } = {
    supported: false,
    reason: "not probed",
  };
  /** Every test skips, loudly, when the cluster cannot run user-namespaced Pods. */
  const requireUserNamespaces = (ctx: { skip: (note?: string) => void }): void => {
    if (!userNamespaces.supported) {
      ctx.skip(`cluster cannot run user-namespaced Pods: ${userNamespaces.reason}`);
    }
  };

  beforeAll(async () => {
    const kubeconfigPath = process.env["KUBECONFIG"];
    userNamespaces = await probeUserNamespaces();
    if (!userNamespaces.supported) {
      console.warn(
        `[docker-service e2e] SKIPPING: this cluster cannot run user-namespaced Pods (${userNamespaces.reason}). ` +
          "The workspace-scoped Docker suite needs nodes with user-namespace support (containerd ≥ 2.0, kernel ≥ 6.3, idmap-capable kubelet dir); kind on GitHub-hosted runners does not qualify.",
      );
      return;
    }
    registryForward = await startRegistryForward();
    publishedImage = await buildWorkspaceImage({
      blueprint,
      registryPort: registryForward.port,
      tag: "fedora-docker",
      kubeconfigPath,
    });
    const config = kubernetesRuntimeConfigSchema.parse({
      namespace: NAMESPACE,
      volumeMappings: [{ logicalRoot: "/var/lib/mend/store", claimName: "mend-store" }],
      resources: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      },
      certManagerIssuer: { name: "sealant-internal" },
      nodeSelector: { "sealant.sh/e2e-role": "workspace" },
      topologySpread: false,
      readinessTimeoutMs: 10 * 60_000,
      docker: { enabled: true, graphSize: "4Gi" },
      ...(kubeconfigPath === undefined ? {} : { kubeconfigPath }),
    });
    adapter = new KubernetesRuntimeAdapter({
      id: "k8s",
      config,
      api: createLiveKubernetesApi({ namespace: NAMESPACE, kubeconfigPath }),
      clientTls,
      controlChannel: forwardedControlChannel,
    });
  }, 30 * 60_000);

  afterAll(async () => {
    if (adapter !== undefined && podName !== "") {
      await adapter.stop({ resourceId: podName }).catch(() => undefined);
    }
    registryForward?.child.kill("SIGTERM");
  });

  it(
    "becomes ready as a user-namespaced Pod with the rootless daemon as a sidecar",
    async (ctx) => {
      requireUserNamespaces(ctx);
      const result = await adapter.launch({
        blueprint,
        publishedImage,
        runId: RUN_ID,
        workspaceId: "ws-e2e-docker",
      });
      expect(result.status).toBe("ready");
      podName = result.resourceId;
      target = { kind: "websocket", url: result.endpoint ?? "", tls: clientTls };

      const spec = JSON.parse(await kubectl("get", "pod", podName, "-o", "json")) as {
        spec: {
          hostUsers?: boolean;
          initContainers?: Array<{ name: string; securityContext?: { privileged?: boolean } }>;
          containers: Array<{ name: string; securityContext?: { privileged?: boolean } }>;
        };
      };
      expect(spec.spec.hostUsers).toBe(false);
      expect(spec.spec.initContainers?.map((c) => c.name)).toEqual(["docker"]);
      expect(spec.spec.initContainers?.[0]?.securityContext?.privileged).toBe(true);
      expect(spec.spec.containers[0]?.securityContext?.privileged).toBe(false);

      // Root in the workspace is a mapped uid, not the node's root: the map's host side is not 0.
      const uidMap = await runIn(target, "id -u && cat /proc/self/uid_map");
      expect(uidMap.exitCode).toBe(0);
      const [inside, ...mapLines] = uidMap.stdout.trim().split("\n");
      expect(inside).toBe("0");
      const [, hostStart] = (mapLines[0] ?? "").trim().split(/\s+/);
      expect(Number(hostStart)).toBeGreaterThan(0);
    },
    15 * 60_000,
  );

  it("runs a nested container through the workspace-scoped daemon", async (ctx) => {
    requireUserNamespaces(ctx);
    const nested = await runIn(target!, "docker run --rm alpine:3.20 echo nested-ok");
    expect(nested.exitCode).toBe(0);
    expect(nested.stdout.trim()).toBe("nested-ok");
    const info = await runIn(target!, "docker info --format '{{.SecurityOptions}}'");
    expect(info.stdout).toContain("name=rootless");
  }, 300_000);

  it("publishes a nested container's port on the Pod loopback and on the `docker` name", async (ctx) => {
    requireUserNamespaces(ctx);
    const started = await runIn(
      target!,
      "docker run -d --rm --name e2e-web -p 18080:80 nginx:alpine >/dev/null && sleep 3 && echo started",
    );
    expect(started.stdout.trim()).toBe("started");
    try {
      const fetch = (host: string): Promise<{ stdout: string; exitCode: number }> =>
        runIn(
          target!,
          `(curl -fsS http://${host}:18080/ || wget -qO- http://${host}:18080/) | head -c 15`,
        );
      const viaLoopback = await fetch("127.0.0.1");
      expect(viaLoopback.exitCode).toBe(0);
      expect(viaLoopback.stdout).toContain("<!DOCTYPE html>");
      // The alias Mend's Service dial chain falls back to (forward({ host: "docker" })).
      const viaAlias = await fetch("docker");
      expect(viaAlias.exitCode).toBe(0);
      expect(viaAlias.stdout).toContain("<!DOCTYPE html>");
    } finally {
      await runIn(target!, "docker rm -f e2e-web >/dev/null 2>&1 || true");
    }
  }, 300_000);

  it("stops idempotently and leaves nothing labelled for the run", async (ctx) => {
    requireUserNamespaces(ctx);
    const first = await adapter.stop({ resourceId: podName });
    expect(first.outcome).toBe("stopped");
    const second = await adapter.stop({ resourceId: podName });
    expect(second.outcome).toBe("not-found");
    const goneDeadline = Date.now() + 120_000;
    for (;;) {
      const remaining = (
        await kubectl("get", "pods", "-l", `sealant.sh/run-id=${RUN_ID}`, "-o", "name")
      ).trim();
      if (remaining === "") {
        break;
      }
      if (Date.now() > goneDeadline) {
        expect(remaining).toBe("");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    podName = "";
  }, 180_000);
});
