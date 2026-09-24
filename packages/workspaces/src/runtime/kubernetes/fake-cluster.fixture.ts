/**
 * An in-memory Kubernetes API for adapter tests: Pods, Services, Secrets, ConfigMaps and
 * Certificates in maps, Pod watches fed by hand, and a log of every call. No cluster, no network.
 * Shared by the adapter's own tests and the runtime conformance test.
 */
import type { V1ConfigMap, V1Pod, V1PodStatus, V1Secret, V1Service } from "@kubernetes/client-node";

import type {
  CreateOutcome,
  DeleteOutcome,
  DeletePodOptions,
  KubernetesApi,
  PodWatchHandlers,
} from "./api.js";
import type { CertificateObject } from "./manifests.js";

export interface FakeCluster extends KubernetesApi {
  readonly pods: Map<string, V1Pod>;
  readonly services: Map<string, V1Service>;
  readonly secrets: Map<string, V1Secret>;
  readonly configmaps: Map<string, V1ConfigMap>;
  readonly certificates: Map<string, CertificateObject>;
  /** Make newly created pods reach this phase on the next read. */
  nextPhase: string;
  /** When set, newly created pods report this full status instead of `{ phase: nextPhase }`. */
  nextStatus: V1PodStatus | undefined;
  /** `<pod>/<container>` → log tail the fake serves. */
  readonly logTails: Map<string, string>;
  readonly log: string[];
  /** Every Pod watch opened, oldest first; tests feed events and end streams by hand. */
  readonly watches: FakeWatch[];
  /** When set, `deletePod` only stamps the Pod Terminating and leaves it listed. */
  deletesLinger: boolean;
}

export interface FakeWatch {
  readonly selector: string;
  readonly handlers: PodWatchHandlers;
  closed: boolean;
}

export const fakeCluster = (): FakeCluster => {
  const pods = new Map<string, V1Pod>();
  const services = new Map<string, V1Service>();
  const secrets = new Map<string, V1Secret>();
  const configmaps = new Map<string, V1ConfigMap>();
  const certificates = new Map<string, CertificateObject>();
  const log: string[] = [];
  const create = <T extends { metadata?: { name?: string | undefined } | undefined }>(
    store: Map<string, T>,
    kind: string,
    object: T,
  ): CreateOutcome<T> => {
    const name = object.metadata?.name ?? "";
    log.push(`create ${kind} ${name}`);
    if (store.has(name)) {
      return { outcome: "conflict" };
    }
    store.set(name, object);
    return { outcome: "created", object };
  };
  const del = (store: Map<string, unknown>, kind: string, name: string): DeleteOutcome => {
    log.push(`delete ${kind} ${name}`);
    return store.delete(name) ? "deleted" : "not-found";
  };
  const cluster: FakeCluster = {
    namespace: "ns",
    pods,
    services,
    secrets,
    configmaps,
    certificates,
    nextPhase: "Running",
    nextStatus: undefined,
    logTails: new Map<string, string>(),
    log,
    watches: [],
    deletesLinger: false,
    createPod: async (pod) => create(pods, "pod", pod),
    getPod: async (name) => {
      const pod = pods.get(name);
      if (pod === undefined) {
        return undefined;
      }
      return { ...pod, status: pod.status ?? cluster.nextStatus ?? { phase: cluster.nextPhase } };
    },
    deletePod: async (name, options?: DeletePodOptions) => {
      const grace = options?.gracePeriodSeconds;
      log.push(`delete pod ${name}${grace === undefined ? "" : ` grace=${String(grace)}`}`);
      const pod = pods.get(name);
      if (pod === undefined) {
        return "not-found";
      }
      if (cluster.deletesLinger) {
        pods.set(name, {
          ...pod,
          metadata: {
            ...pod.metadata,
            deletionTimestamp: new Date(),
            ...(grace === undefined ? {} : { deletionGracePeriodSeconds: grace }),
          },
        });
      } else {
        pods.delete(name);
      }
      return "deleted";
    },
    listPods: async () => {
      log.push("list pods");
      return [...pods.values()];
    },
    watchPods: (selector, handlers) => {
      const watch: FakeWatch = { selector, handlers, closed: false };
      cluster.watches.push(watch);
      return {
        close: () => {
          watch.closed = true;
        },
      };
    },
    createService: async (service) => create(services, "service", service),
    getService: async (name) => services.get(name),
    deleteService: async (name) => del(services, "service", name),
    listServices: async () => [...services.values()],
    createSecret: async (secret) => create(secrets, "secret", secret),
    replaceSecret: async (secret) => {
      log.push(`replace secret ${secret.metadata?.name ?? ""}`);
      secrets.set(secret.metadata?.name ?? "", secret);
      return secret;
    },
    getSecret: async (name) => secrets.get(name),
    readPodLogTail: async (name, container) => cluster.logTails.get(`${name}/${container}`) ?? "",
    getConfigMap: async (name) => configmaps.get(name),
    deleteSecret: async (name) => del(secrets, "secret", name),
    listSecrets: async () => [...secrets.values()],
    createCertificate: async (certificate) => create(certificates, "certificate", certificate),
    getCertificate: async (name) => certificates.get(name),
    deleteCertificate: async (name) => del(certificates, "certificate", name),
    listCertificates: async () => [...certificates.values()],
  };
  return cluster;
};
