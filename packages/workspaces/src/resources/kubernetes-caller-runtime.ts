import { PassThrough, Readable, Writable } from "node:stream";

import {
  CoreV1Api,
  Exec,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  type KubernetesObject,
  type V1StatefulSet,
  type V1PersistentVolumeClaim,
  type V1NetworkPolicy,
  type V1Service,
  type V1Secret,
} from "@kubernetes/client-node";
import {
  resourceInstanceSecretEnvSchema,
  type ResourceInstanceState,
} from "@sealant/api-contracts";
import type { CredentialCipherService } from "@sealant/credentials";
import type { ResourceInstanceRecord } from "@sealant/db";
import { Effect, Schema } from "effect";

import { callerInstanceName, type ResourceCallerConfig } from "./caller-config.js";
import { CALLER_GUARD_IMAGE } from "./docker-caller-runtime.js";
import type {
  ResourceRuntime,
  ResourceUpResult,
  ArchivedVolume,
  ResourceExecCommand,
  ResourceExecResult,
} from "./docker-resource-runtime.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const notFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === 404;
const privateRanges = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

/** Kubernetes lowering is pure and independently reviewable alongside the Docker rules. */
export const callerKubernetesObjects = (
  instance: ResourceInstanceRecord,
  options: { readonly namespace: string; readonly callers: ResourceCallerConfig },
): {
  readonly statefulSet: V1StatefulSet;
  readonly volumes: ReadonlyArray<V1PersistentVolumeClaim>;
  readonly policy: V1NetworkPolicy;
  readonly service: V1Service;
  readonly caller: Extract<ResourceCallerConfig[number], { readonly kind: "kubernetes" }>;
} => {
  const name = callerInstanceName(instance.id);
  const reach = instance.spec.reach;
  const caller = options.callers.find((entry) => entry.name === reach?.caller);
  if (
    reach === undefined ||
    caller?.kind !== "kubernetes" ||
    !caller.callbackPorts.includes(reach.callbackPort)
  )
    throw new Error("No Kubernetes caller is configured for this callback port.");
  const metadata = { name, namespace: options.namespace, labels: { "sealant.sh/service": name } };
  const selector = { matchLabels: { "sealant.sh/service": name } };
  const peer = {
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": caller.namespace } },
    podSelector: { matchLabels: caller.podLabels },
  };
  const ready = instance.spec.ready;
  const probe =
    ready.kind === "tcp"
      ? { tcpSocket: { port: ready.port } }
      : { exec: { command: [...ready.argv] } };
  const volumes = instance.spec.volumes.map(
    (volume): V1PersistentVolumeClaim => ({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: `${name}-${volume.name}`,
        namespace: options.namespace,
        labels: metadata.labels,
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: String(volume.storageBytes) } },
      },
    }),
  );
  const statefulSet: V1StatefulSet = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata,
    spec: {
      serviceName: name,
      replicas: 1,
      selector,
      updateStrategy: { type: "OnDelete" },
      persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
      template: {
        metadata: {
          labels: metadata.labels,
          annotations: { "sealant.sh/spec-digest": instance.specDigest },
        },
        spec: {
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: 60,
          containers: [
            {
              name: "instance",
              image: instance.spec.image,
              ...(instance.spec.command === null ? {} : { args: [...instance.spec.command] }),
              env: Object.entries(instance.spec.env).map(([key, value]) => ({ name: key, value })),
              envFrom: [{ secretRef: { name } }],
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              resources: {
                requests: {
                  cpu: `${instance.spec.limits.cpuMillicores}m`,
                  memory: String(instance.spec.limits.memoryBytes),
                },
                limits: {
                  cpu: `${instance.spec.limits.cpuMillicores}m`,
                  memory: String(instance.spec.limits.memoryBytes),
                },
              },
              readinessProbe: { ...probe, periodSeconds: 5, timeoutSeconds: 2 },
              volumeMounts: instance.spec.volumes.map((volume) => ({
                name: volume.name,
                mountPath: volume.mountPath,
              })),
            },
          ],
          volumes: instance.spec.volumes.map((volume) => ({
            name: volume.name,
            persistentVolumeClaim: { claimName: `${name}-${volume.name}` },
          })),
        },
      },
    },
  };
  const policy: V1NetworkPolicy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata,
    spec: {
      podSelector: selector,
      policyTypes: ["Ingress", "Egress"],
      ingress: [{ _from: [peer], ports: [{ protocol: "TCP", port: reach.port }] }],
      egress: [
        { to: [peer], ports: [{ protocol: "TCP", port: reach.callbackPort }] },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: privateRanges } }] },
      ],
    },
  };
  const service: V1Service = {
    apiVersion: "v1",
    kind: "Service",
    metadata,
    spec: {
      type: "ClusterIP",
      selector: selector.matchLabels,
      ports: [{ name: "service", port: reach.port, targetPort: reach.port, protocol: "TCP" }],
    },
  };
  return { statefulSet, volumes, policy, service, caller };
};

/** Caller-only StatefulSets. The operator must attest NetworkPolicy enforcement before use. */
export class KubernetesCallerRuntime implements ResourceRuntime {
  private readonly objects: KubernetesObjectApi;
  private readonly core: CoreV1Api;
  private readonly execution: Exec;
  /** No cluster access occurs until the first operation. */
  public constructor(
    private readonly options: {
      readonly namespace: string;
      readonly callers: ResourceCallerConfig;
      readonly networkPolicyEnforced: boolean;
      readonly cipher?: CredentialCipherService;
      readonly kubeconfigPath?: string;
      readonly readyTimeoutMs?: number;
    },
  ) {
    const config = new KubeConfig();
    if (options.kubeconfigPath === undefined) config.loadFromDefault();
    else config.loadFromFile(options.kubeconfigPath);
    this.objects = KubernetesObjectApi.makeApiClient(config);
    this.core = config.makeApiClient(CoreV1Api);
    this.execution = new Exec(config);
  }
  private async apply<T extends KubernetesObject>(object: T): Promise<void> {
    await this.objects.patch(
      object,
      undefined,
      undefined,
      "sealant-caller-instances",
      true,
      PatchStrategy.ServerSideApply,
    );
  }
  private async remove(object: KubernetesObject): Promise<void> {
    try {
      await this.objects.delete(object);
    } catch (error) {
      // Kubernetes errors may retain complete provider requests, including Secret bodies.
      // eslint-disable-next-line preserve-caught-error
      if (!notFound(error)) throw new Error("The Kubernetes service object could not be removed.");
    }
  }
  private async pod(name: string) {
    try {
      return await this.core.readNamespacedPod({ namespace: this.options.namespace, name });
    } catch (error) {
      if (notFound(error)) return undefined;
      // eslint-disable-next-line preserve-caught-error -- Provider request bodies stay private.
      throw new Error("The Kubernetes service pod could not be observed.");
    }
  }
  /** Refuses a missing binding or unenforced policy before writing desired state. */
  public validateCaller(spec: ResourceInstanceRecord["spec"]): void {
    if (!this.options.networkPolicyEnforced)
      throw new Error("Caller instances require NetworkPolicy enforcement.");
    const reach = spec.reach;
    const caller = this.options.callers.find((entry) => entry.name === reach?.caller);
    if (
      reach === undefined ||
      caller?.kind !== "kubernetes" ||
      !caller.callbackPorts.includes(reach.callbackPort)
    )
      throw new Error("No Kubernetes caller is configured for this callback port.");
    if (spec.ready.kind === "exec" && spec.ready.user !== null)
      throw new Error("Kubernetes exec probes use the image user; name no different probe user.");
  }
  /** Mend reaches a stable ClusterIP DNS name; callbacks use its configured private Service. */
  public endpoint(instance: ResourceInstanceRecord): {
    readonly host: string;
    readonly port: number;
    readonly callbackHost: string;
  } {
    const { caller } = callerKubernetesObjects(instance, this.options);
    const port = instance.spec.reach?.port;
    if (port === undefined) throw new Error("Kubernetes resources require caller reach.");
    return {
      host: `${callerInstanceName(instance.id)}.${this.options.namespace}.svc.cluster.local`,
      port,
      callbackHost: caller.host,
    };
  }
  /** Stops the old pod before applying a replacement template, retaining every PVC. */
  public async up(instance: ResourceInstanceRecord): Promise<ResourceUpResult> {
    const confirmedVolumes = [...instance.volumes];
    try {
      this.validateCaller(instance.spec);
      const objects = callerKubernetesObjects(instance, this.options);
      const name = callerInstanceName(instance.id);
      const current = await this.pod(`${name}-0`);
      if (
        current !== undefined &&
        current.metadata?.annotations?.["sealant.sh/spec-digest"] !== instance.specDigest
      )
        await this.stop(instance);
      for (const volume of objects.volumes) {
        if (instance.volumes.some((prior) => `${name}-${prior.name}` === volume.metadata?.name)) {
          try {
            await this.objects.read({
              apiVersion: "v1",
              kind: "PersistentVolumeClaim",
              metadata: { name: volume.metadata?.name ?? "", namespace: this.options.namespace },
            });
          } catch {
            throw new Error("A retained PVC is missing.");
          }
        }
        await this.apply(volume);
        const declared = instance.spec.volumes.find(
          (entry) => `${name}-${entry.name}` === volume.metadata?.name,
        );
        if (
          declared !== undefined &&
          !confirmedVolumes.some((entry) => entry.name === declared.name)
        )
          confirmedVolumes.push(declared);
      }
      // Policy and Secret exist before any pod starts.
      await this.apply(objects.policy);
      let secrets: Readonly<Record<string, string>> = {};
      if (instance.secretEnvSealed != null) {
        if (this.options.cipher === undefined)
          throw new Error("The credential cipher is unavailable.");
        secrets = Schema.decodeUnknownSync(Schema.fromJsonString(resourceInstanceSecretEnvSchema))(
          await Effect.runPromise(this.options.cipher.decrypt(instance.secretEnvSealed)),
        );
      }
      await this.apply<V1Secret>({
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name,
          namespace: this.options.namespace,
          labels: { "sealant.sh/service": name },
        },
        type: "Opaque",
        data: Object.fromEntries(
          Object.entries(secrets).map(([key, value]) => [
            key,
            Buffer.from(value).toString("base64"),
          ]),
        ),
      });
      await this.apply(objects.service);
      await this.apply(objects.statefulSet);
      const deadline = Date.now() + (this.options.readyTimeoutMs ?? 120_000);
      do {
        const state = await this.health(instance);
        if (state.kind === "running")
          return { state, volumes: instance.spec.volumes, startedAt: new Date(state.since) };
        await delay(1000);
      } while (Date.now() < deadline);
    } catch {
      /* Provider errors may contain secret request bodies. */
    }
    await this.stop(instance).catch(() => undefined);
    return {
      volumes: confirmedVolumes,
      state: {
        kind: "failed",
        at: new Date().toISOString(),
        message:
          "The Kubernetes caller instance could not start. Check its policy, image, retained claims and health.",
      },
    };
  }
  /** A fresh pod readiness condition includes its observation time in the API response. */
  public async health(instance: ResourceInstanceRecord): Promise<ResourceInstanceState> {
    const pod = await this.pod(`${callerInstanceName(instance.id)}-0`);
    const at = new Date().toISOString();
    if (
      pod?.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      )
    )
      return { kind: "running", since: (pod.status.startTime ?? new Date()).toISOString() };
    return pod === undefined
      ? { kind: "exited", at, exitCode: null }
      : { kind: "starting", since: at };
  }
  /** Scale to zero and wait for the old pod to disappear before releasing compute or volumes. */
  public async stop(instance: ResourceInstanceRecord): Promise<void> {
    const name = callerInstanceName(instance.id);
    let controllerExists = true;
    try {
      await this.objects.read({
        apiVersion: "apps/v1",
        kind: "StatefulSet",
        metadata: { name, namespace: this.options.namespace },
      });
    } catch (error) {
      if (notFound(error)) controllerExists = false;
      else {
        // eslint-disable-next-line preserve-caught-error -- Provider request bodies stay private.
        throw new Error("The Kubernetes instance could not be stopped.");
      }
    }
    if (controllerExists)
      await this.objects.patch(
        {
          apiVersion: "apps/v1",
          kind: "StatefulSet",
          metadata: { name, namespace: this.options.namespace },
          spec: { replicas: 0 },
        },
        undefined,
        undefined,
        "sealant-caller-stop",
        undefined,
        PatchStrategy.MergePatch,
      );
    else
      await this.remove({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: `${name}-0`, namespace: this.options.namespace },
      });
    const deadline = Date.now() + 120_000;
    while ((await this.pod(`${name}-0`)) !== undefined) {
      if (Date.now() > deadline) throw new Error("The Kubernetes instance is still stopping.");
      await delay(1000);
    }
  }
  /** StatefulSet, Service, Secret and policy go; PVCs have no owner reference and remain. */
  public async archive(instance: ResourceInstanceRecord): Promise<ReadonlyArray<ArchivedVolume>> {
    await this.stop(instance);
    const objects = callerKubernetesObjects(instance, this.options);
    for (const object of [
      objects.statefulSet,
      objects.service,
      objects.policy,
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: callerInstanceName(instance.id), namespace: this.options.namespace },
      },
    ])
      await this.remove(object);
    return instance.spec.volumes.map((volume) => ({
      name: volume.name,
      dockerName: `${callerInstanceName(instance.id)}-${volume.name}`,
      bytes: null,
    }));
  }
  /** Commands are sent over Kubernetes exec, excluded from Core run records and diagnostics. */
  public async exec(
    instance: ResourceInstanceRecord,
    command: ResourceExecCommand,
    stdin: AsyncIterable<Uint8Array> | null,
  ): Promise<ResourceExecResult> {
    if (command.user !== null) throw new Error("Kubernetes exec uses the image user.");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let truncated = false;
    const retain = (old: Buffer, chunk: Buffer) => {
      const all = Buffer.concat([old, chunk]);
      if (all.length > 1024 * 1024) truncated = true;
      return all.subarray(-1024 * 1024);
    };
    stdout.on("data", (chunk: Buffer) => {
      out = retain(out, chunk);
    });
    stderr.on("data", (chunk: Buffer) => {
      err = retain(err, chunk);
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The Kubernetes exec timed out; process completion is unknown."));
      }, command.timeoutMs);
      this.execution
        .exec(
          this.options.namespace,
          `${callerInstanceName(instance.id)}-0`,
          "instance",
          [...command.argv],
          stdout,
          stderr,
          stdin === null ? null : Readable.from(stdin),
          false,
          (status) => {
            clearTimeout(timer);
            const exit = status.details?.causes?.find(
              (cause) => cause.reason === "ExitCode",
            )?.message;
            resolve({
              exitCode: status.status === "Success" ? 0 : exit === undefined ? null : Number(exit),
              stdout: out.toString(),
              stderr: err.toString(),
              truncated,
              timedOut: false,
            });
          },
        )
        .catch(() => {
          clearTimeout(timer);
          reject(new Error("The Kubernetes exec could not start."));
        });
    });
  }
  /** A helper mounts only the stopped volume read-only and streams a tar through Kubernetes exec. */
  public async backup(
    instance: ResourceInstanceRecord,
    volume: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const name = callerInstanceName(instance.id);
    const helper = `${name}-backup`;
    if (instance.desired !== "stopped" || (await this.pod(`${name}-0`)) !== undefined)
      throw new Error("Stop the instance before backing up its volume.");
    if (!instance.spec.volumes.some((entry) => entry.name === volume))
      throw new Error("The instance has no such retained volume.");
    const claim = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: `${name}-${volume}`, namespace: this.options.namespace },
    };
    await this.objects.read(claim);
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: helper,
        namespace: this.options.namespace,
        labels: { "sealant.sh/backup": helper },
      },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        containers: [
          {
            name: "backup",
            image: CALLER_GUARD_IMAGE,
            command: ["sleep", "infinity"],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"], add: ["DAC_READ_SEARCH"] },
            },
            volumeMounts: [{ name: "data", mountPath: "/volume", readOnly: true }],
          },
        ],
        volumes: [
          {
            name: "data",
            persistentVolumeClaim: { claimName: `${name}-${volume}`, readOnly: true },
          },
        ],
      },
    };
    const policy = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: pod.metadata,
      spec: {
        podSelector: { matchLabels: pod.metadata.labels },
        policyTypes: ["Ingress", "Egress"],
        ingress: [],
        egress: [],
      },
    };
    await this.remove(pod);
    const removalDeadline = Date.now() + 120_000;
    while ((await this.pod(helper)) !== undefined) {
      if (Date.now() > removalDeadline)
        throw new Error("The previous backup helper is still stopping.");
      await delay(1000);
    }
    await this.apply(policy);
    await this.apply(pod);
    const deadline = Date.now() + 120_000;
    while ((await this.pod(helper))?.status?.phase !== "Running") {
      if (Date.now() > deadline) {
        await this.remove(pod);
        throw new Error("The backup helper did not start.");
      }
      await delay(1000);
    }
    const output = new PassThrough();
    const discard = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const cleanup = async () => {
      await this.remove(pod);
      await this.remove(policy);
    };
    try {
      await this.execution.exec(
        this.options.namespace,
        helper,
        "backup",
        ["tar", "-C", "/volume", "-cf", "-", "."],
        output,
        discard,
        null,
        false,
        (status) => {
          if (status.status !== "Success")
            output.destroy(new Error("The Kubernetes volume backup failed."));
          else output.end();
        },
      );
    } catch {
      await cleanup();
      throw new Error("The Kubernetes volume backup could not start.");
    }
    output.once("close", () => {
      void cleanup().catch(() => undefined);
    });
    const iterator = output[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const next = await iterator.next();
        if (next.done === true) {
          await cleanup();
          controller.close();
        } else
          controller.enqueue(Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value));
      },
      cancel: async () => {
        output.destroy();
        await cleanup();
      },
    });
  }
  /** Workspace reach is deliberately unavailable on this provider. */
  public async attachExecutor(): Promise<void> {
    throw new Error("Kubernetes caller instances admit no workspace links.");
  }
  /** No workspace network can have been created by this runtime. */
  public async detachExecutor(): Promise<void> {}
  /** Kubernetes controllers converge pod/network state; no workspace links are admitted. */
  public async converge(): Promise<void> {}
  /** The reconciler refreshes caller instances from their durable records on every tick. */
  public async observe(): Promise<
    ReadonlyMap<string, { readonly running: boolean; readonly exitCode: number | null }>
  > {
    return new Map();
  }
}
