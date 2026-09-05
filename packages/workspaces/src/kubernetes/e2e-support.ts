/**
 * Shared plumbing for the kind-cluster E2E suites (`cross-node.e2e.ts`, `docker-service.e2e.ts`).
 *
 * The test process runs OUTSIDE the cluster, so every control connection goes through a
 * `kubectl port-forward` to the workspace Service with SNI set to the Service DNS name — the same
 * mTLS handshake a worker Pod performs, just routed. Nothing here is imported by production code.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { WorkspaceBlueprint } from "@sealant/validators";
import { Effect } from "effect";

import { createLiveKubernetesBuildApi } from "../images/kubernetes/api.js";
import { KubernetesWorkspaceImageBuilder } from "../images/kubernetes/builder.js";
import { kubernetesBuildConfigSchema } from "../images/kubernetes/config.js";
import { createZotRegistryClient } from "../registry/client.js";
import { liveControlChannel, type ControlChannel } from "../runtime/kubernetes/adapter.js";
import type { PublishedImage } from "../runtime/runtime-adapter.js";
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
}): Promise<PublishedImage> => {
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
    config: buildConfig,
    api: createLiveKubernetesBuildApi({
      namespace: NAMESPACE,
      kubeconfigPath: input.kubeconfigPath,
    }),
    registryClient,
  });
  return (
    await builder.buildAndPublish({
      spec: input.blueprint,
      repository: "sealant/workspaces/e2e",
      tag: input.tag,
      buildId: `e2e-${input.tag}`,
    })
  ).publishedImage;
};
