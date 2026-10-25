/**
 * Shared plumbing for the kind-cluster E2E suites.
 *
 * The test process runs OUTSIDE the cluster, so every control connection goes through a
 * `kubectl port-forward` to the workspace Service with SNI set to the Service DNS name — the same
 * mTLS handshake a worker Pod performs, just routed. Nothing here is imported by production code.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { WorkspaceBlueprint } from "@sealant/validators";
import { Effect } from "effect";

import { processImagePlatform } from "../buildkit/platform.js";
import type { BuildAndPublishResult } from "../images/image-builder.js";
import { createLiveKubernetesBuildApi } from "../images/kubernetes/api.js";
import { KubernetesWorkspaceImageBuilder } from "../images/kubernetes/builder.js";
import { kubernetesBuildConfigSchema } from "../images/kubernetes/config.js";
import { createZotRegistryClient } from "../registry/client.js";
import { liveControlChannel, type ControlChannel } from "../runtime/kubernetes/adapter.js";
import { SealantRuntimeControlLive, type SealantTarget } from "../sealantd/runtime.js";
import { execInWorkspace } from "../sealantd/target.js";

export const E2E_ENABLED = process.env["SEALANT_K8S_E2E"] === "1";
export const NAMESPACE = "sealant";
export const REGISTRY_PUSH = "sealant-registry.sealant.svc:5000";

const execFileAsync = promisify(execFile);

// Resolve relative to the repo root, not the suite's cwd (pnpm --filter runs in the package).
const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../..");
const tlsDir = path.resolve(repoRoot, process.env["E2E_TLS_DIR"] ?? "deploy/e2e/kind/.tls");
export const clientTls = {
  caPath: `${tlsDir}/ca.crt`,
  certPath: `${tlsDir}/tls.crt`,
  keyPath: `${tlsDir}/tls.key`,
};

export const kubectl = async (...args: string[]): Promise<string> =>
  (await execFileAsync("kubectl", ["-n", NAMESPACE, ...args], { maxBuffer: 16 * 1024 * 1024 }))
    .stdout;

export const nodeOf = async (pod: string): Promise<string> =>
  (await kubectl("get", "pod", pod, "-o", "jsonpath={.spec.nodeName}")).trim();

const forwardedPort = (child: ChildProcess, what: string): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out);
      if (match?.[1] !== undefined) {
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`${what} exited with ${String(code)}: ${out}`)));
    child.on("error", reject);
  });

/**
 * Port-forward the workspace Service and rewrite the target so the host process reaches it:
 * 127.0.0.1:<local port> on the wire, SNI + certificate verification against the Service name.
 */
export const withForwardedTarget = async <T>(
  target: SealantTarget,
  fn: (forwarded: SealantTarget) => Promise<T>,
): Promise<T> => {
  if (target.kind !== "websocket") {
    return fn(target);
  }
  if (target.tls === undefined) {
    throw new Error(
      "the kind e2e expects an mTLS websocket target (the k8s adapter always sets tls).",
    );
  }
  const url = new URL(target.url);
  const service = url.hostname.split(".")[0] ?? "";
  const child = spawn(
    "kubectl",
    ["-n", NAMESPACE, "port-forward", `svc/${service}`, `:${url.port}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const localPort = await forwardedPort(child, "port-forward");
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
export const forwardedControlChannel: ControlChannel = {
  health: (target) =>
    withForwardedTarget(target, (forwarded) => liveControlChannel.health(forwarded)),
  writeCredentialFiles: (target, files) =>
    withForwardedTarget(target, (forwarded) =>
      liveControlChannel.writeCredentialFiles(forwarded, files),
    ),
};

/** Run a shell snippet in the workspace over the control channel. */
export const runIn = (
  target: SealantTarget,
  command: string,
  cwd = "/workspace/repo",
): Promise<{ stdout: string; exitCode: number }> =>
  withForwardedTarget(target, (forwarded) =>
    Effect.runPromise(
      execInWorkspace(forwarded, { executable: "sh", args: ["-c", command], cwd }).pipe(
        Effect.provide(SealantRuntimeControlLive),
      ),
    ),
  );

export interface RegistryForward {
  readonly child: ChildProcess;
  readonly port: number;
}

/**
 * The registry client (digest resolution) reaches the in-cluster zot through a suite-lifetime
 * port-forward; in-cluster consumers use the Service DNS name.
 */
export const startRegistryForward = async (): Promise<RegistryForward> => {
  const child = spawn(
    "kubectl",
    ["-n", NAMESPACE, "port-forward", "svc/sealant-registry", ":5000"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const port = await forwardedPort(child, "registry port-forward");
  return { child, port };
};

/** Build + push a workspace image with a rootless BuildKit Job (no Docker socket anywhere). */
export const buildWorkspaceImage = async (input: {
  readonly blueprint: WorkspaceBlueprint;
  readonly registryPort: number;
  readonly tag: string;
  readonly kubeconfigPath: string | undefined;
}): Promise<BuildAndPublishResult> => {
  const registryClient = createZotRegistryClient({
    baseUrl: `http://127.0.0.1:${String(input.registryPort)}`,
    pushRegistry: REGISTRY_PUSH,
  });
  const buildConfig = kubernetesBuildConfigSchema.parse({
    namespace: NAMESPACE,
    pushRegistry: REGISTRY_PUSH,
    registryInsecure: true,
    resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "4", memory: "6Gi" } },
    timeoutMs: 25 * 60_000,
    ...(input.kubeconfigPath === undefined ? {} : { kubeconfigPath: input.kubeconfigPath }),
  });
  const builder = new KubernetesWorkspaceImageBuilder({
    platform: processImagePlatform(),
    config: buildConfig,
    api: createLiveKubernetesBuildApi({
      namespace: NAMESPACE,
      kubeconfigPath: input.kubeconfigPath,
    }),
    registryClient,
  });
  return builder.buildAndPublish({
    spec: input.blueprint,
    repository: "sealant/workspaces/e2e",
    tag: input.tag,
    buildId: `e2e-${input.tag}`,
  });
};

export interface UserNamespaceSupport {
  readonly supported: boolean;
  readonly reason: string;
}

/**
 * Can this cluster run a user-namespaced Pod? A bare `hostUsers: false` Pod that only sleeps:
 * Ready within the budget means yes; anything else (sandbox creation failing, the field ignored
 * and the uid map left as the host's) means a suite that needs one has nothing to prove here.
 */
export const probeUserNamespaces = async (): Promise<UserNamespaceSupport> => {
  const name = `userns-probe-${Date.now().toString(36)}`;
  const manifest = JSON.stringify({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: NAMESPACE, labels: { "sealant.sh/e2e-probe": "userns" } },
    spec: {
      hostUsers: false,
      restartPolicy: "Never",
      nodeSelector: { "sealant.sh/e2e-role": "workspace" },
      containers: [{ name: "probe", image: "alpine:3.20", command: ["sleep", "120"] }],
    },
  });
  try {
    // `kubectl apply -f -` needs stdin; go through a temp file instead.
    const file = `/tmp/${name}.json`;
    await writeFile(file, manifest);
    try {
      await kubectl("apply", "-f", file);
    } finally {
      await rm(file, { force: true });
    }
    const ready = await kubectl(
      "wait",
      "--for=condition=Ready",
      `pod/${name}`,
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
        `involvedObject.name=${name}`,
        "-o",
        "jsonpath={range .items[*]}{.reason}: {.message}{'\\n'}{end}",
      ).catch(() => "");
      return {
        supported: false,
        reason: `a bare hostUsers:false Pod did not become Ready in 90s${events.trim() === "" ? "" : `:\n${events.trim().slice(0, 600)}`}`,
      };
    }
    const uidMap = (
      await kubectl("exec", name, "--", "cat", "/proc/self/uid_map").catch(() => "")
    ).trim();
    if (/^\s*0\s+0\s+4294967295\s*$/.test(uidMap)) {
      return {
        supported: false,
        reason: "hostUsers:false was ignored — the Pod's uid map is the host's (0 0 4294967295)",
      };
    }
    return { supported: true, reason: `uid map: ${uidMap.replace(/\s+/g, " ")}` };
  } finally {
    await kubectl("delete", "pod", name, "--ignore-not-found", "--wait=false").catch(
      () => undefined,
    );
  }
};
