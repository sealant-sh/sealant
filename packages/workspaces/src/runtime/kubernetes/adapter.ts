/**
 * The Kubernetes runtime adapter (design §D2, §D5). One implementation serves both the `k8s` and
 * `k3s` runtime families; the subclasses in `../k8s-runtime-adapter.ts` / `../k3s-runtime-adapter.ts`
 * only pick the id and a distribution profile.
 *
 * Launch, for one workspace attempt (run id):
 *   1. `supports`: family, ephemeral persistence, outbound network, no DinD (later PR), gVisor
 *      only with a configured RuntimeClass.
 *   2. Lower mounts (PVC + subPath) and build every manifest from the launch input.
 *   3. Create-or-adopt: Certificate, env Secret, launch Secret, Service, Pod. A 409 on create means
 *      a redelivered launch; the existing object is read and must carry this run's labels.
 *   4. Wait for the Pod to be Running (Failed / a dead container is a readable error).
 *   5. Open the REAL control channel (mTLS WebSocket, the same transport every consumer uses)
 *      and require `runtime.health` to answer — that, not Pod phase, is `ready`.
 *   6. Write credential files over that authenticated channel (stdin, never argv), then delete
 *      the launch Secret: the daemon has consumed `env.json` at boot.
 *
 * Stop deletes Pod, Service, Certificate and both Secrets; each delete tolerates not-found, and
 * the outcome is `not-found` only when the Pod itself was already gone.
 */
import { readFile } from "node:fs/promises";

import type { V1Pod } from "@kubernetes/client-node";
import { StreamKind } from "@sealant/runtime-client";
import type { EventEnvelope } from "@sealant/runtime-protocol";
import { Effect, Option, Schedule, Stream } from "effect";

import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantTarget,
  type SealantWebSocketClientTls,
} from "../../sealantd/runtime.js";
import { buildCredentialFileWriteScript } from "../credential-files.js";
import { buildDotfilesArchiveManifest, hasDotfilesArchives } from "../launch-material.js";
import { DOTFILES_ARCHIVE_MOUNT_PATH, collectMountIntents } from "../mount-intent.js";
import {
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterStopInput,
  parseRuntimeAdapterSupportInput,
  type CredentialFileInjection,
  type RuntimeAdapter,
  type RuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchResult,
  type RuntimeAdapterStopInput,
  type RuntimeAdapterStopResult,
  type RuntimeAdapterSupport,
  type RuntimeAdapterSupportInput,
} from "../runtime-adapter.js";
import type { KubernetesApi } from "./api.js";
import { LABEL_RUN_ID, type KubernetesRuntimeConfig } from "./config.js";
import {
  buildCertificate,
  buildEnvSecret,
  buildLaunchSecret,
  buildPod,
  buildService,
  DOTFILES_SUBDIR,
  LAUNCH_MOUNT_PATH,
  managedSelector,
  plainEnvEntries,
  secretEnvEntries,
  secretPayloadBytes,
  workspaceLabels,
} from "./manifests.js";
import {
  workspaceControlEndpoint,
  workspaceResourceNames,
  workspaceServiceDnsName,
} from "./names.js";
import { lowerMountIntents, MountLoweringError } from "./volumes.js";

export type KubernetesAdapterId = "k8s" | "k3s";

export interface KubernetesRuntimeAdapterOptions {
  readonly id: KubernetesAdapterId;
  readonly config: KubernetesRuntimeConfig;
  readonly api: KubernetesApi;
  /** The worker's client mTLS material for reaching sealantd; required for readiness. */
  readonly clientTls: SealantWebSocketClientTls;
  /** Test seam: readiness polling cadence. */
  readonly pollIntervalMs?: number;
  /** Test seam: override the control-channel probe (health + credential files). */
  readonly controlChannel?: ControlChannel;
  readonly now?: () => number;
}

/** What the adapter needs from the control channel, behind an interface for tests. */
export interface ControlChannel {
  readonly health: (target: SealantTarget) => Promise<void>;
  readonly writeCredentialFiles: (
    target: SealantTarget,
    files: readonly CredentialFileInjection[],
  ) => Promise<void>;
}

const createAdapterError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

const POLL_INTERVAL_MS = 1000;
const HEALTH_RETRY = { schedule: Schedule.spaced("1 second"), times: 30 };

/** Live control channel: the same Effect runtime + transport every worker path uses. */
export const liveControlChannel: ControlChannel = {
  health: (target) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const session = yield* runtime.connect(target);
          yield* session.health;
        }),
      ).pipe(Effect.provide(SealantRuntimeControlLive)),
    ),
  writeCredentialFiles: (target, files) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const session = yield* runtime.connect(target);
          for (const file of files) {
            const script = buildCredentialFileWriteScript(file);
            const accepted = yield* session.exec({
              executable: "sh",
              args: ["-c", script],
              stdin: true,
            });
            yield* session.writeStdin(accepted.processId, Buffer.from(file.contentBase64, "utf8"));
            yield* session.closeStdin(accepted.processId);
            const exit = yield* session.events.pipe(
              Stream.filter((event: EventEnvelope) => event.processId === accepted.processId),
              Stream.filter((event: EventEnvelope) => event.payload.case === "processExited"),
              Stream.take(1),
              Stream.runHead,
            );
            const code =
              Option.isSome(exit) && exit.value.payload.case === "processExited"
                ? exit.value.payload.value.exitCode
                : undefined;
            if (code !== 0) {
              return yield* Effect.fail(
                createAdapterError(
                  "credential-file-injection-failed",
                  `Writing credential file '${file.path}' exited with ${String(code)}.`,
                ),
              );
            }
          }
        }),
      ).pipe(Effect.provide(SealantRuntimeControlLive)),
    ),
};

// Keep the StreamKind import meaningful for readers comparing with `execInWorkspace`.
void StreamKind;

/** The support decision, pure. */
export const supportForKubernetes = (
  id: KubernetesAdapterId,
  config: Pick<KubernetesRuntimeConfig, "gvisorRuntimeClass">,
  input: RuntimeAdapterSupportInput,
): RuntimeAdapterSupport => {
  const family = input.blueprint.target.runtime.family;
  if (family !== "auto" && family !== id) {
    return {
      supported: false,
      reason: "unsupported-runtime",
      message: `The ${id} adapter cannot serve runtime family '${family}'.`,
    };
  }
  if (input.blueprint.runtime.persistence !== "ephemeral") {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The Kubernetes adapter only supports ephemeral persistence.",
    };
  }
  if (!input.blueprint.runtime.network.outbound) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The Kubernetes adapter requires outbound network access.",
    };
  }
  if (input.blueprint.tooling.services?.docker?.enabled === true) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "Workspace-scoped Docker (tooling.services.docker) is not available on Kubernetes yet; it ships as a separate DinD sidecar capability.",
    };
  }
  if (
    input.blueprint.runtime.envFrom.length > 0 ||
    input.blueprint.runtime.kubernetes.serviceAccountName !== undefined
  ) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "Cluster env references are not resolved by this platform build yet; the worker-side resolution ships in the next release.",
    };
  }
  if (input.blueprint.runtime.ociRuntime === "runsc" && config.gvisorRuntimeClass === undefined) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "ociRuntime 'runsc' needs a gVisor RuntimeClass (SEALANT_K8S_GVISOR_RUNTIME_CLASS) on this cluster.",
    };
  }
  if (
    input.blueprint.sources.workspace.kind === "mount" ||
    input.blueprint.sources.mounts.length > 0
  ) {
    // Lowering is validated at launch; here we only confirm the adapter can take mounts at all.
    return { supported: true };
  }
  return { supported: true };
};

const podPhase = (pod: V1Pod | undefined): string | undefined => pod?.status?.phase;

const describePodProblem = (pod: V1Pod): string => {
  const statuses = pod.status?.containerStatuses ?? [];
  for (const status of statuses) {
    const waiting = status.state?.waiting;
    if (waiting?.reason !== undefined) {
      return `${waiting.reason}${waiting.message === undefined ? "" : `: ${waiting.message}`}`;
    }
    const terminated = status.state?.terminated;
    if (terminated !== undefined) {
      return `container exited with ${String(terminated.exitCode)}${terminated.reason === undefined ? "" : ` (${terminated.reason})`}`;
    }
  }
  const condition = pod.status?.conditions?.find(
    (c) => c.status !== "True" && c.message !== undefined,
  );
  if (condition?.message !== undefined) {
    return `${condition.type}: ${condition.message}`;
  }
  return pod.status?.message ?? pod.status?.reason ?? `phase ${podPhase(pod) ?? "unknown"}`;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class KubernetesRuntimeAdapter implements RuntimeAdapter {
  readonly id: KubernetesAdapterId;
  readonly #config: KubernetesRuntimeConfig;
  readonly #api: KubernetesApi;
  readonly #clientTls: SealantWebSocketClientTls;
  readonly #pollIntervalMs: number;
  readonly #control: ControlChannel;
  readonly #now: () => number;

  constructor(options: KubernetesRuntimeAdapterOptions) {
    this.id = options.id;
    this.#config = options.config;
    this.#api = options.api;
    this.#clientTls = options.clientTls;
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.#control = options.controlChannel ?? liveControlChannel;
    this.#now = options.now ?? Date.now;
  }

  get config(): KubernetesRuntimeConfig {
    return this.#config;
  }

  supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport {
    return supportForKubernetes(this.id, this.#config, parseRuntimeAdapterSupportInput(input));
  }

  /**
   * Every workspace Pod this worker manages in the namespace (for reconciliation): the run id
   * label and the Pod name (which is also the `resourceId` a stop needs).
   */
  async listManagedWorkspaces(): Promise<
    ReadonlyArray<{ readonly runId: string; readonly resourceId: string }>
  > {
    const pods = await this.#api.listPods(managedSelector(this.#config));
    const out: Array<{ runId: string; resourceId: string }> = [];
    for (const pod of pods) {
      const runId = pod.metadata?.labels?.[LABEL_RUN_ID];
      const name = pod.metadata?.name;
      if (runId !== undefined && name !== undefined) {
        out.push({ runId, resourceId: name });
      }
    }
    return out;
  }

  /** Run ids only; see `listManagedWorkspaces`. */
  async listManagedRunIds(): Promise<readonly string[]> {
    return [...new Set((await this.listManagedWorkspaces()).map((entry) => entry.runId))];
  }

  async launch(input: RuntimeAdapterLaunchInput): Promise<RuntimeAdapterLaunchResult> {
    const parsed = parseRuntimeAdapterLaunchInput(input);
    const support = this.supports({ blueprint: parsed.blueprint });
    if (!support.supported) {
      throw createAdapterError(support.reason, support.message);
    }
    const runId = parsed.runId;
    if (runId === undefined) {
      throw createAdapterError(
        "unsupported-runtime-requirement",
        "The Kubernetes adapter needs a run id to derive deterministic resource names.",
      );
    }
    const config = this.#config;
    const names = workspaceResourceNames(runId);
    const labels = workspaceLabels(config, {
      runId,
      adapter: this.id,
      workspaceId: parsed.workspaceId,
      principalId: parsed.principalId,
      pool: parsed.pool,
    });

    // Mounts: every intent except launch material lowers from the store claims; a staged
    // dotfiles dir (too large for the Secret) is itself a launch-material intent on the staging
    // claim, which the same mapping table covers.
    const intents = collectMountIntents({
      blueprint: parsed.blueprint,
      dotfilesArchiveDir: parsed.dotfilesArchiveDir,
      // secret env never travels via a directory on Kubernetes
      secretEnvDir: undefined,
    });
    let lowered;
    try {
      lowered = lowerMountIntents(intents, config.volumeMappings);
    } catch (error) {
      if (error instanceof MountLoweringError) {
        throw createAdapterError(error.code, error.message);
      }
      throw error;
    }

    // Launch Secret: boot secret env + dotfiles that fit. Dotfiles that did not fit were staged
    // on the staging claim by the stager and arrive as `dotfilesArchiveDir`.
    const dotfilesInSecret =
      parsed.dotfilesArchiveDir === undefined && hasDotfilesArchives(parsed.blueprint)
        ? {
            manifestJson: `${JSON.stringify(buildDotfilesArchiveManifest(parsed.blueprint.runtime.dotfilesArchives))}\n`,
            archives: parsed.blueprint.runtime.dotfilesArchives.map((archive) =>
              Buffer.from(archive.data, "base64"),
            ),
          }
        : undefined;
    const launchSecret = buildLaunchSecret(names, config.namespace, labels, {
      secretEnvJson: parsed.secretEnv === undefined ? undefined : JSON.stringify(parsed.secretEnv),
      dotfiles: dotfilesInSecret,
    });
    if (
      launchSecret !== undefined &&
      secretPayloadBytes(launchSecret) > config.launchSecretBudgetBytes
    ) {
      throw createAdapterError(
        "launch-material-too-large",
        `Launch material is ${Math.round(secretPayloadBytes(launchSecret) / 1024)} KiB, over the ${Math.round(config.launchSecretBudgetBytes / 1024)} KiB Secret budget; configure a staging claim (SEALANT_K8S_STAGING_LOGICAL_ROOT) for large dotfiles archives.`,
      );
    }
    // What the daemon reads: staged archives are mounted at the fixed launch-material path, small
    // ones are projected into the launch Secret.
    const dotfilesArchiveDir =
      parsed.dotfilesArchiveDir !== undefined
        ? DOTFILES_ARCHIVE_MOUNT_PATH
        : dotfilesInSecret === undefined
          ? undefined
          : `${LAUNCH_MOUNT_PATH}/${DOTFILES_SUBDIR}`;

    const cloneAuthKeyBase64 =
      parsed.workspaceCloneAuth?.type === "file-ref"
        ? await this.#readCloneKeyBase64(parsed.workspaceCloneAuth.path)
        : undefined;
    const secretEntries = secretEnvEntries(parsed, cloneAuthKeyBase64);
    const envSecret = buildEnvSecret(names, config.namespace, labels, secretEntries);
    const plainEnv = plainEnvEntries(parsed, config, {
      secretEnvFile: parsed.secretEnv !== undefined,
      dotfilesArchiveDir,
    });

    const priorityClassName =
      parsed.pool === "hot" ? config.hotPoolPriorityClass : config.workspacePriorityClass;
    const pod = buildPod({
      names,
      config,
      labels,
      input: parsed,
      lowered,
      plainEnv,
      secretEnvKeys: secretEntries.map(([key]) => key),
      launchSecret,
      priorityClassName,
    });
    const certificate = buildCertificate(names, config, labels);
    const service = buildService(names, config, labels, runId);

    // Create or adopt, in dependency order. Secrets are replaced on conflict (a redelivery may
    // carry re-resolved tokens); everything else must already be ours.
    await this.#ensureCertificate(certificate, runId);
    if (envSecret !== undefined) {
      await this.#ensureSecret(envSecret, runId);
    }
    if (launchSecret !== undefined) {
      await this.#ensureSecret(launchSecret, runId);
    }
    await this.#ensureService(service, runId);
    const liveness = await this.#ensurePod(pod, runId);
    if (liveness === "recreated" || liveness === "created" || liveness === "adopted") {
      // fallthrough to readiness
    }

    const endpoint = workspaceControlEndpoint(names.service, config.namespace, config.controlPort);
    const target: SealantTarget = {
      kind: "websocket",
      url: endpoint,
      tls: {
        ...this.#clientTls,
        servername: workspaceServiceDnsName(names.service, config.namespace),
      },
    };

    try {
      await this.#awaitRunning(names.pod, runId);
      await this.#awaitHealthy(target, names.pod);
      if (parsed.credentialFiles !== undefined && parsed.credentialFiles.length > 0) {
        await this.#control.writeCredentialFiles(target, parsed.credentialFiles);
      }
    } catch (error) {
      await this.#deleteAll(names).catch(() => undefined);
      throw error;
    }

    // The daemon consumed env.json and the dotfiles at boot; nothing may still need the Secret.
    if (launchSecret !== undefined) {
      await this.#api.deleteSecret(names.launchSecret);
    }

    return {
      adapter: this.id,
      resourceId: names.pod,
      reference: names.pod,
      status: "ready",
      endpoint,
    };
  }

  async stop(input: RuntimeAdapterStopInput): Promise<RuntimeAdapterStopResult> {
    const parsed = parseRuntimeAdapterStopInput(input);
    const names = workspaceResourceNames(parsed.resourceId);
    // `resourceId` IS the pod name (derived from the run id); derive siblings from it directly.
    const podName = parsed.resourceId;
    const base = podName;
    // Kubernetes deletion is asynchronous: a Pod stays Terminating for its grace period and a
    // second delete during that window still "succeeds". Match the Docker adapter's contract —
    // the stop that INITIATES teardown reports "stopped", any later one "not-found" — by treating
    // an already-terminating Pod as gone. The deletes below still run for idempotent cleanup.
    const existing = await this.#api.getPod(podName);
    const alreadyStopping =
      existing === undefined || existing.metadata?.deletionTimestamp !== undefined;
    const deleted = await this.#api.deletePod(podName);
    const outcome = alreadyStopping ? "not-found" : deleted;
    await this.#api.deleteService(base);
    await this.#api.deleteCertificate(base);
    await this.#api.deleteSecret(`${base}-launch`);
    await this.#api.deleteSecret(`${base}-env`);
    await this.#api.deleteSecret(`${base}-tls`);
    void names;
    return {
      adapter: this.id,
      resourceId: parsed.resourceId,
      outcome: outcome === "deleted" ? "stopped" : "not-found",
    };
  }

  async #deleteAll(names: ReturnType<typeof workspaceResourceNames>): Promise<void> {
    await this.#api.deletePod(names.pod);
    await this.#api.deleteService(names.service);
    await this.#api.deleteCertificate(names.certificate);
    await this.#api.deleteSecret(names.launchSecret);
    await this.#api.deleteSecret(names.envSecret);
    await this.#api.deleteSecret(names.tlsSecret);
  }

  async #readCloneKeyBase64(path: string | undefined): Promise<string | undefined> {
    if (path === undefined || path.length === 0) {
      return undefined;
    }
    let keyData: string;
    try {
      keyData = await readFile(path, "utf8");
    } catch (error) {
      throw createAdapterError(
        "unsupported-access-mode",
        `Workspace clone key could not be read at '${path}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const trimmed = keyData.trim();
    if (trimmed.length === 0) {
      throw createAdapterError(
        "unsupported-access-mode",
        `Workspace clone key file is empty: ${path}`,
      );
    }
    return Buffer.from(`${trimmed}\n`, "utf8").toString("base64");
  }

  #assertOurs(kind: string, labels: Record<string, string> | undefined, runId: string): void {
    if (
      labels?.[LABEL_RUN_ID] !==
      workspaceLabels(this.#config, { runId, adapter: this.id })[LABEL_RUN_ID]
    ) {
      throw createAdapterError(
        "adapter-unavailable",
        `A ${kind} with this run's name exists but is not labelled for run ${runId}; refusing to adopt it.`,
      );
    }
  }

  async #ensureCertificate(
    certificate: ReturnType<typeof buildCertificate>,
    runId: string,
  ): Promise<void> {
    const created = await this.#api.createCertificate(certificate);
    if (created.outcome === "conflict") {
      const existing = await this.#api.getCertificate(certificate.metadata.name);
      this.#assertOurs("Certificate", existing?.metadata.labels, runId);
    }
  }

  async #ensureSecret(
    secret: NonNullable<ReturnType<typeof buildEnvSecret>>,
    runId: string,
  ): Promise<void> {
    const created = await this.#api.createSecret(secret);
    if (created.outcome === "conflict") {
      const existing = await this.#api.getSecret(secret.metadata?.name ?? "");
      this.#assertOurs("Secret", existing?.metadata?.labels, runId);
      await this.#api.replaceSecret(secret);
    }
  }

  async #ensureService(service: ReturnType<typeof buildService>, runId: string): Promise<void> {
    const created = await this.#api.createService(service);
    if (created.outcome === "conflict") {
      const existing = await this.#api.getService(service.metadata?.name ?? "");
      this.#assertOurs("Service", existing?.metadata?.labels, runId);
    }
  }

  async #ensurePod(pod: V1Pod, runId: string): Promise<"created" | "adopted" | "recreated"> {
    const name = pod.metadata?.name ?? "";
    const created = await this.#api.createPod(pod);
    if (created.outcome === "created") {
      return "created";
    }
    const existing = await this.#api.getPod(name);
    this.#assertOurs("Pod", existing?.metadata?.labels, runId);
    const phase = podPhase(existing);
    if (phase === "Failed" || phase === "Succeeded") {
      // A dead Pod from an earlier attempt at this run: replace it (restartPolicy is Never).
      await this.#api.deletePod(name);
      await this.#awaitGone(name);
      const recreated = await this.#api.createPod(pod);
      if (recreated.outcome === "conflict") {
        throw createAdapterError(
          "adapter-unavailable",
          `Pod ${name} could not be recreated after deletion.`,
        );
      }
      return "recreated";
    }
    return "adopted";
  }

  async #awaitGone(name: string): Promise<void> {
    const deadline = this.#now() + this.#config.readinessTimeoutMs;
    while ((await this.#api.getPod(name)) !== undefined) {
      if (this.#now() > deadline) {
        throw createAdapterError("adapter-unavailable", `Pod ${name} did not terminate in time.`);
      }
      await sleep(this.#pollIntervalMs);
    }
  }

  async #awaitRunning(name: string, runId: string): Promise<void> {
    const deadline = this.#now() + this.#config.readinessTimeoutMs;
    let last: V1Pod | undefined;
    for (;;) {
      last = await this.#api.getPod(name);
      const phase = podPhase(last);
      if (phase === "Running") {
        return;
      }
      if (last === undefined) {
        throw createAdapterError(
          "adapter-unavailable",
          `Pod ${name} for run ${runId} disappeared while starting.`,
        );
      }
      if (phase === "Failed" || phase === "Succeeded") {
        throw createAdapterError(
          "adapter-unavailable",
          `Pod ${name} for run ${runId} ended before it became ready: ${describePodProblem(last)}.`,
        );
      }
      if (this.#now() > deadline) {
        throw createAdapterError(
          "adapter-unavailable",
          `Pod ${name} for run ${runId} was not Running within ${String(this.#config.readinessTimeoutMs)} ms: ${describePodProblem(last)}.`,
        );
      }
      await sleep(this.#pollIntervalMs);
    }
  }

  async #awaitHealthy(target: SealantTarget, podName: string): Promise<void> {
    const deadline = this.#now() + this.#config.readinessTimeoutMs;
    let lastError: unknown;
    while (this.#now() <= deadline) {
      try {
        await this.#control.health(target);
        return;
      } catch (error) {
        lastError = error;
        // The Pod may have died while we were connecting; surface that instead of a TLS error.
        const pod = await this.#api.getPod(podName);
        const phase = podPhase(pod);
        if (pod !== undefined && (phase === "Failed" || phase === "Succeeded")) {
          throw createAdapterError(
            "adapter-unavailable",
            `Pod ${podName} ended before its control channel answered: ${describePodProblem(pod)}.`,
          );
        }
        await sleep(this.#pollIntervalMs);
      }
    }
    throw createAdapterError(
      "adapter-unavailable",
      `sealantd in ${podName} did not answer over ${target.kind === "websocket" ? target.url : "the control channel"} within ${String(this.#config.readinessTimeoutMs)} ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

void HEALTH_RETRY;
