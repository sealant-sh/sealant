/**
 * Cross-node workspace E2E on a disposable kind cluster (design §3, PR 6).
 *
 * Proves the storage property Mend depends on — the EXACT linked-worktree shape, not "two Pods
 * can write hello.txt to an RWX claim":
 *
 *   1. a "store" Pod on node A (the Mend stand-in) creates a bare repo and a linked worktree on
 *      the RWX claim at the canonical path `/var/lib/mend/store/...`;
 *   2. the Kubernetes adapter launches a mount-sourced workspace on node B, mounting the worktree
 *      at /workspace/repo and the git common dir path-identically, and becomes ready only when
 *      `runtime.health` answers over mutual-TLS WebSocket;
 *   3. git works inside the Pod (linked worktree resolves), the agent's write is immediately
 *      visible on node A, a commit made on node A is immediately visible in the Pod;
 *   4. a harness-style exec streams telemetry over WSS; a PTY session opens and reattaches;
 *   5. stop is idempotent; the Pod is deleted and recreated on the OTHER node with the same
 *      worktree and the earlier write intact.
 *
 * Gated on SEALANT_K8S_E2E=1 with a cluster from `deploy/e2e/kind/up.sh`. The test process runs
 * OUTSIDE the cluster, so every control connection goes through a `kubectl port-forward` to the
 * workspace Service with SNI set to the Service DNS name — the same mTLS handshake a worker Pod
 * performs, just routed.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseWorkspaceBlueprint } from "@sealant/validators";
import { Effect, Option, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLiveKubernetesBuildApi } from "../images/kubernetes/api.js";
import { KubernetesWorkspaceImageBuilder } from "../images/kubernetes/builder.js";
import { kubernetesBuildConfigSchema } from "../images/kubernetes/config.js";
import { createZotRegistryClient } from "../registry/client.js";
import {
  KubernetesRuntimeAdapter,
  liveControlChannel,
  type ControlChannel,
} from "../runtime/kubernetes/adapter.js";
import { createLiveKubernetesApi } from "../runtime/kubernetes/api.js";
import { kubernetesRuntimeConfigSchema } from "../runtime/kubernetes/config.js";
import type { PublishedImage, RuntimeAdapterLaunchInput } from "../runtime/runtime-adapter.js";
import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantTarget,
} from "../sealantd/runtime.js";
import { execInWorkspace } from "../sealantd/target.js";

const enabled = process.env["SEALANT_K8S_E2E"] === "1";
const execFileAsync = promisify(execFile);

const NAMESPACE = "sealant";
const STORE_ROOT = "/var/lib/mend/store";
const PROJECT = "acme";
const SESSION = "session-e2e-1";
const WORKTREE = `${STORE_ROOT}/${PROJECT}/worktrees/${SESSION}`;
const COMMON_DIR = `${STORE_ROOT}/${PROJECT}/repo.git`;
const RUN_ID = `run-e2e-${Date.now().toString(36)}`;

// Resolve relative to the repo root, not the suite's cwd (pnpm --filter runs in the package).
const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../..");
const tlsDir = path.resolve(repoRoot, process.env["E2E_TLS_DIR"] ?? "deploy/e2e/kind/.tls");
const clientTls = {
  caPath: `${tlsDir}/ca.crt`,
  certPath: `${tlsDir}/tls.crt`,
  keyPath: `${tlsDir}/tls.key`,
};

const kubectl = async (...args: string[]): Promise<string> =>
  (await execFileAsync("kubectl", ["-n", NAMESPACE, ...args], { maxBuffer: 16 * 1024 * 1024 }))
    .stdout;

/** Run a shell snippet in the store Pod (the Mend stand-in on node A). */
const inStore = (script: string): Promise<string> =>
  kubectl("exec", "store", "--", "sh", "-ec", script);

/**
 * Port-forward the workspace Service and rewrite the target so the host process reaches it:
 * 127.0.0.1:<local port> on the wire, SNI + certificate verification against the Service name.
 */
const withForwardedTarget = async <T>(
  target: SealantTarget,
  fn: (forwarded: SealantTarget) => Promise<T>,
): Promise<T> => {
  if (target.kind !== "websocket") {
    return fn(target);
  }
  const url = new URL(target.url);
  const service = url.hostname.split(".")[0] ?? "";
  const child: ChildProcess = spawn(
    "kubectl",
    ["-n", NAMESPACE, "port-forward", `svc/${service}`, `:${url.port}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const localPort = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out);
      if (match?.[1] !== undefined) {
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) =>
      reject(new Error(`port-forward exited with ${String(code)}: ${out}`)),
    );
    child.on("error", reject);
  });
  try {
    return await fn({
      kind: "websocket",
      url: `wss://127.0.0.1:${localPort}${url.pathname}`,
      tls: { ...target.tls, servername: url.hostname },
    });
  } finally {
    child.kill("SIGTERM");
  }
};

/** The adapter's readiness + credential-file channel, routed through the port-forward. */
const forwardedControlChannel: ControlChannel = {
  health: (target) =>
    withForwardedTarget(target, (forwarded) => liveControlChannel.health(forwarded)),
  writeCredentialFiles: (target, files) =>
    withForwardedTarget(target, (forwarded) =>
      liveControlChannel.writeCredentialFiles(forwarded, files),
    ),
};

const runIn = (
  target: SealantTarget,
  command: string,
): Promise<{ stdout: string; exitCode: number }> =>
  withForwardedTarget(target, (forwarded) =>
    Effect.runPromise(
      execInWorkspace(forwarded, {
        executable: "sh",
        args: ["-c", command],
        cwd: "/workspace/repo",
      }).pipe(Effect.provide(SealantRuntimeControlLive)),
    ),
  );

const nodeOf = async (pod: string): Promise<string> =>
  (await kubectl("get", "pod", pod, "-o", "jsonpath={.spec.nodeName}")).trim();

const blueprint = parseWorkspaceBlueprint({
  version: "1",
  sources: {
    workspace: { kind: "mount", hostPath: WORKTREE },
    inputs: [],
    mounts: [{ hostPath: COMMON_DIR, mountPath: COMMON_DIR, readOnly: false }],
  },
  harness: { id: "codex" },
  access: { ssh: { enabled: false, listenPort: 2222 } },
  tooling: { packages: [] },
  customization: {
    defaultShell: "bash",
    dotfilesManager: "auto",
    dotfilesTarget: "home",
    applyDotfiles: false,
    dotfilesBootstrap: false,
  },
  // A long-lived foreground: the daemon's contract is "foreground exited → shut down", and a
  // headless `codex` exits immediately. Mend's real sessions hold a shell/agent the same way.
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

describe.skipIf(!enabled)("Kubernetes cross-node workspace", () => {
  let adapter: KubernetesRuntimeAdapter;
  let publishedImage: PublishedImage;
  let storeNode = "";
  let workspaceNode = "";
  let target: SealantTarget | undefined;
  let podName = "";
  let registryForward: ChildProcess | undefined;

  beforeAll(async () => {
    const kubeconfigPath = process.env["KUBECONFIG"];
    // The registry client (digest resolution) reaches the in-cluster zot through a
    // suite-lifetime port-forward; in-cluster consumers use the Service DNS name.
    registryForward = spawn(
      "kubectl",
      ["-n", NAMESPACE, "port-forward", "svc/sealant-registry", ":5000"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const registryPort = await new Promise<number>((resolve, reject) => {
      let out = "";
      registryForward?.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const match = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out);
        if (match?.[1] !== undefined) {
          resolve(Number(match[1]));
        }
      });
      registryForward?.on("exit", (code) =>
        reject(new Error(`registry port-forward exited with ${String(code)}: ${out}`)),
      );
      registryForward?.on("error", reject);
    });
    const registryClient = createZotRegistryClient({
      baseUrl: `http://127.0.0.1:${registryPort}`,
      pushRegistry: "sealant-registry.sealant.svc:5000",
    });

    // 0. Build + push the workspace image with a rootless BuildKit Job (no Docker socket anywhere).
    const buildConfig = kubernetesBuildConfigSchema.parse({
      namespace: NAMESPACE,
      pushRegistry: "sealant-registry.sealant.svc:5000",
      registryInsecure: true,
      resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "4", memory: "6Gi" } },
      timeoutMs: 25 * 60_000,
      ...(kubeconfigPath === undefined ? {} : { kubeconfigPath }),
    });
    const builder = new KubernetesWorkspaceImageBuilder({
      config: buildConfig,
      api: createLiveKubernetesBuildApi({ namespace: NAMESPACE, kubeconfigPath }),
      registryClient,
    });
    publishedImage = (
      await builder.buildAndPublish({
        spec: blueprint,
        repository: "sealant/workspaces/e2e",
        tag: "fedora",
        buildId: "e2e",
      })
    ).publishedImage;
    expect(publishedImage.digest).toMatch(/^sha256:/);

    // 1. The store Pod (node A) creates the bare repo + linked worktree on the claim.
    storeNode = await nodeOf("store");
    await inStore(`
      rm -rf ${STORE_ROOT}/${PROJECT}
      mkdir -p ${STORE_ROOT}/${PROJECT}/worktrees
      git init -q --bare ${COMMON_DIR}
      tmp=$(mktemp -d); git -C $tmp init -q; echo '# acme' > $tmp/README.md; git -C $tmp add .; git -C $tmp commit -qm init
      git -C $tmp push -q ${COMMON_DIR} HEAD:refs/heads/main
      git -C ${COMMON_DIR} symbolic-ref HEAD refs/heads/main
      git -C ${COMMON_DIR} worktree add -q -b mend/session/e2e ${WORKTREE} main
      cat ${WORKTREE}/.git
    `);
    const pointer = await inStore(`cat ${WORKTREE}/.git`);
    expect(pointer.trim()).toBe(`gitdir: ${COMMON_DIR}/worktrees/${SESSION}`);

    const config = kubernetesRuntimeConfigSchema.parse({
      namespace: NAMESPACE,
      volumeMappings: [{ logicalRoot: STORE_ROOT, claimName: "mend-store" }],
      resources: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      },
      certManagerIssuer: { name: "sealant-internal" },
      nodeSelector: { "sealant.sh/e2e-role": "workspace" },
      topologySpread: false,
      readinessTimeoutMs: 10 * 60_000,
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
    registryForward?.kill("SIGTERM");
  });

  const launchInput = (): RuntimeAdapterLaunchInput => ({
    blueprint,
    publishedImage,
    runId: RUN_ID,
    workspaceId: "ws-e2e",
    credentialFiles: [
      {
        path: "$HOME/.codex/auth.json",
        contentBase64: Buffer.from('{"e2e":true}').toString("base64"),
        mode: "600",
      },
    ],
  });

  it(
    "launches on a different node than the store and is ready only once sealantd answers over mTLS",
    async () => {
      const result = await adapter.launch(launchInput());
      expect(result.status).toBe("ready");
      expect(result.endpoint).toMatch(/^wss:\/\/ws-.*\.sealant\.svc:7443\/control$/);
      podName = result.resourceId;
      target = { kind: "websocket", url: result.endpoint ?? "", tls: clientTls };
      workspaceNode = await nodeOf(podName);
      expect(workspaceNode).not.toBe(storeNode);
    },
    15 * 60_000,
  );

  it("resolves the linked worktree inside the Pod and streams telemetry over WSS", async () => {
    const status = await runIn(
      target!,
      "git rev-parse --git-common-dir && git rev-parse --show-toplevel && git status --porcelain && git log --oneline -1",
    );
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(COMMON_DIR);
    expect(status.stdout).toContain("/workspace/repo");
    expect(status.stdout).toContain("init");
    const credential = await runIn(target!, 'cat "$HOME/.codex/auth.json"');
    expect(credential.stdout).toBe('{"e2e":true}');
  }, 120_000);

  it("makes an agent's write immediately visible to the store, and a store commit visible in the Pod", async () => {
    const write = await runIn(
      target!,
      "echo 'from the agent' > from-agent.txt && git status --porcelain",
    );
    expect(write.exitCode).toBe(0);
    expect(write.stdout).toContain("from-agent.txt");
    // Same inode, seen from node A without any sync step.
    expect((await inStore(`cat ${WORKTREE}/from-agent.txt`)).trim()).toBe("from the agent");
    // Mend commits (a checkpoint) from node A; the Pod sees the new HEAD through the shared common dir.
    await inStore(
      `cd ${WORKTREE} && git add from-agent.txt && git commit -qm 'checkpoint from store'`,
    );
    const log = await runIn(target!, "git log --oneline -1 && git status --porcelain");
    expect(log.stdout).toContain("checkpoint from store");
    expect(
      log.stdout.split("\n").filter((line) => line.startsWith("?? ") || line.startsWith(" M"))
        .length,
    ).toBe(0);
  }, 120_000);

  it("opens a PTY session, reattaches from a new connection, and lists it", async () => {
    await withForwardedTarget(target!, async (forwarded) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const first = yield* runtime.connect(forwarded);
          const opened = yield* first.openSession({
            shell: "/bin/bash",
            args: ["-l"],
            cols: 80,
            rows: 24,
            cwd: "/workspace/repo",
          });
          yield* first.writeSessionInput(
            opened.sessionId,
            Buffer.from("echo reattach-marker-$((40+2))\n"),
          );
          // A second control connection attaches with replay: the marker must arrive.
          const second = yield* runtime.connect(forwarded);
          const sessions = yield* second.listSessions;
          expect(sessions.map((s) => s.sessionId)).toContain(opened.sessionId);
          const channel = yield* second.attachSession(opened.sessionId, { fromSequence: 0n });
          const seen = yield* Stream.fromAsyncIterable(channel, (e) => e).pipe(
            Stream.map((chunk) => Buffer.from(chunk).toString()),
            Stream.scan("", (acc, chunk) => acc + chunk),
            Stream.takeUntil((acc) => acc.includes("reattach-marker-42")),
            Stream.runLast,
          );
          expect(Option.getOrElse(seen, () => "")).toContain("reattach-marker-42");
          yield* first.closeSession(opened.sessionId);
        }),
      ).pipe(Effect.provide(SealantRuntimeControlLive));
      await Effect.runPromise(program);
    });
  }, 120_000);

  it(
    "stops idempotently and recreates the Pod on another node with the same worktree",
    async () => {
      const first = await adapter.stop({ resourceId: podName });
      expect(first.outcome).toBe("stopped");
      const second = await adapter.stop({ resourceId: podName });
      expect(second.outcome).toBe("not-found");
      // Deletion is asynchronous: the Pod stays Terminating for its grace period. The property
      // is that everything labelled for this run is GONE once that window passes.
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

      // Move the workspace pool label to the store node: the relaunch must land there, remount the
      // same worktree, and still see the agent's earlier write — now committed by the store.
      const previousWorkspaceNode = workspaceNode;
      await execFileAsync("kubectl", [
        "label",
        "node",
        previousWorkspaceNode,
        "sealant.sh/e2e-role-",
        "--overwrite",
      ]);
      await execFileAsync("kubectl", [
        "label",
        "node",
        storeNode,
        "sealant.sh/e2e-role=workspace",
        "--overwrite",
      ]);
      try {
        const result = await adapter.launch(launchInput());
        expect(result.status).toBe("ready");
        podName = result.resourceId;
        target = { kind: "websocket", url: result.endpoint ?? "", tls: clientTls };
        expect(await nodeOf(podName)).toBe(storeNode);
        const check = await runIn(target!, "cat from-agent.txt && git log --oneline -1");
        expect(check.stdout).toContain("from the agent");
        expect(check.stdout).toContain("checkpoint from store");
      } finally {
        await execFileAsync("kubectl", [
          "label",
          "node",
          storeNode,
          "sealant.sh/e2e-role=store",
          "--overwrite",
        ]);
        await execFileAsync("kubectl", [
          "label",
          "node",
          previousWorkspaceNode,
          "sealant.sh/e2e-role=workspace",
          "--overwrite",
        ]);
      }
    },
    15 * 60_000,
  );
});
