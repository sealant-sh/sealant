/**
 * The slice of the Kubernetes API the adapter uses, as a small interface with a live
 * implementation over `@kubernetes/client-node`. Keeping it narrow does two things: the adapter
 * is unit-testable with an in-memory fake, and the RBAC the worker needs is exactly this list
 * (`deploy/kubernetes/rbac/sealant-worker.yaml`).
 *
 * Errors: 404 on reads/deletes becomes `undefined` / `"not-found"`; 409 on creates becomes
 * `"conflict"`; everything else is rethrown as `KubernetesApiError` with the status and a
 * readable message (never the request body).
 */
import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  type V1ConfigMap,
  type V1Pod,
  type V1Secret,
  type V1Service,
} from "@kubernetes/client-node";

import type { CertificateObject } from "./manifests.js";

export class KubernetesApiError extends Error {
  override readonly name = "KubernetesApiError";
  constructor(
    readonly status: number | undefined,
    readonly operation: string,
    message: string,
  ) {
    super(message);
  }
}

export type CreateOutcome<T> =
  | { readonly outcome: "created"; readonly object: T }
  | { readonly outcome: "conflict" };
export type DeleteOutcome = "deleted" | "not-found";

export interface KubernetesApi {
  readonly namespace: string;

  readonly createPod: (pod: V1Pod) => Promise<CreateOutcome<V1Pod>>;
  readonly getPod: (name: string) => Promise<V1Pod | undefined>;
  readonly deletePod: (name: string) => Promise<DeleteOutcome>;
  readonly listPods: (labelSelector: string) => Promise<readonly V1Pod[]>;
  /**
   * Tail of one container's log, for launch failures that name a container (the Docker sidecar
   * that would not start, a workspace that died at boot). Empty when unavailable; never throws.
   */
  readonly readPodLogTail: (
    podName: string,
    container: string,
    tailLines: number,
  ) => Promise<string>;

  readonly createService: (service: V1Service) => Promise<CreateOutcome<V1Service>>;
  readonly getService: (name: string) => Promise<V1Service | undefined>;
  readonly deleteService: (name: string) => Promise<DeleteOutcome>;
  readonly listServices: (labelSelector: string) => Promise<readonly V1Service[]>;

  /** Read-only: bound `runtime.envFrom` ConfigMaps (env-sources.ts). */
  readonly getConfigMap: (name: string) => Promise<V1ConfigMap | undefined>;

  readonly createSecret: (secret: V1Secret) => Promise<CreateOutcome<V1Secret>>;
  readonly replaceSecret: (secret: V1Secret) => Promise<V1Secret>;
  readonly getSecret: (name: string) => Promise<V1Secret | undefined>;
  readonly deleteSecret: (name: string) => Promise<DeleteOutcome>;
  readonly listSecrets: (labelSelector: string) => Promise<readonly V1Secret[]>;

  readonly createCertificate: (
    certificate: CertificateObject,
  ) => Promise<CreateOutcome<CertificateObject>>;
  readonly getCertificate: (name: string) => Promise<CertificateObject | undefined>;
  readonly deleteCertificate: (name: string) => Promise<DeleteOutcome>;
  readonly listCertificates: (labelSelector: string) => Promise<readonly CertificateObject[]>;
}

const CERT_MANAGER = { group: "cert-manager.io", version: "v1", plural: "certificates" } as const;

const statusOf = (error: unknown): number | undefined =>
  error instanceof ApiException ? error.code : undefined;

const toApiError = (operation: string, error: unknown): KubernetesApiError => {
  const status = statusOf(error);
  const reason =
    error instanceof ApiException
      ? `HTTP ${error.code}`
      : error instanceof Error
        ? error.message
        : String(error);
  const hint =
    status === 403
      ? " (the worker's ServiceAccount lacks RBAC for this verb; see deploy/kubernetes/rbac)"
      : status === 401
        ? " (the worker's cluster credentials were rejected)"
        : "";
  return new KubernetesApiError(
    status,
    operation,
    `Kubernetes ${operation} failed: ${reason}${hint}`,
  );
};

const create = async <T>(operation: string, call: () => Promise<T>): Promise<CreateOutcome<T>> => {
  try {
    return { outcome: "created", object: await call() };
  } catch (error) {
    if (statusOf(error) === 409) {
      return { outcome: "conflict" };
    }
    throw toApiError(operation, error);
  }
};

const read = async <T>(operation: string, call: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await call();
  } catch (error) {
    if (statusOf(error) === 404) {
      return undefined;
    }
    throw toApiError(operation, error);
  }
};

const remove = async (operation: string, call: () => Promise<unknown>): Promise<DeleteOutcome> => {
  try {
    await call();
    return "deleted";
  } catch (error) {
    if (statusOf(error) === 404) {
      return "not-found";
    }
    throw toApiError(operation, error);
  }
};

export interface LiveKubernetesApiOptions {
  readonly namespace: string;
  /** Development/test override; production uses in-cluster configuration. */
  readonly kubeconfigPath?: string | undefined;
}

/** Build the live client. In-cluster by default; a kubeconfig path for development. */
export const createLiveKubernetesApi = (options: LiveKubernetesApiOptions): KubernetesApi => {
  const kubeConfig = new KubeConfig();
  if (options.kubeconfigPath !== undefined) {
    kubeConfig.loadFromFile(options.kubeconfigPath);
  } else {
    kubeConfig.loadFromCluster();
  }
  const core = kubeConfig.makeApiClient(CoreV1Api);
  const custom = kubeConfig.makeApiClient(CustomObjectsApi);
  const namespace = options.namespace;
  const background = "Background";

  return {
    namespace,

    createPod: (pod) =>
      create("create pod", () => core.createNamespacedPod({ namespace, body: pod })),
    getPod: (name) => read("read pod", () => core.readNamespacedPod({ name, namespace })),
    deletePod: (name) =>
      remove("delete pod", () =>
        core.deleteNamespacedPod({ name, namespace, propagationPolicy: background }),
      ),
    listPods: async (labelSelector) => {
      try {
        return (await core.listNamespacedPod({ namespace, labelSelector })).items;
      } catch (error) {
        throw toApiError("list pods", error);
      }
    },
    readPodLogTail: async (podName, container, tailLines) => {
      try {
        return await core.readNamespacedPodLog({ name: podName, namespace, container, tailLines });
      } catch {
        return "";
      }
    },

    createService: (service) =>
      create("create service", () => core.createNamespacedService({ namespace, body: service })),
    getService: (name) =>
      read("read service", () => core.readNamespacedService({ name, namespace })),
    deleteService: (name) =>
      remove("delete service", () =>
        core.deleteNamespacedService({ name, namespace, propagationPolicy: background }),
      ),
    listServices: async (labelSelector) => {
      try {
        return (await core.listNamespacedService({ namespace, labelSelector })).items;
      } catch (error) {
        throw toApiError("list services", error);
      }
    },

    getConfigMap: (name) =>
      read("read configmap", () => core.readNamespacedConfigMap({ name, namespace })),

    createSecret: (secret) =>
      create("create secret", () => core.createNamespacedSecret({ namespace, body: secret })),
    replaceSecret: async (secret) => {
      try {
        return await core.replaceNamespacedSecret({
          name: secret.metadata?.name ?? "",
          namespace,
          body: secret,
        });
      } catch (error) {
        throw toApiError("replace secret", error);
      }
    },
    getSecret: (name) => read("read secret", () => core.readNamespacedSecret({ name, namespace })),
    deleteSecret: (name) =>
      remove("delete secret", () =>
        core.deleteNamespacedSecret({ name, namespace, propagationPolicy: background }),
      ),
    listSecrets: async (labelSelector) => {
      try {
        return (await core.listNamespacedSecret({ namespace, labelSelector })).items;
      } catch (error) {
        throw toApiError("list secrets", error);
      }
    },

    createCertificate: (certificate) =>
      create("create certificate", async () => {
        await custom.createNamespacedCustomObject({
          ...CERT_MANAGER,
          namespace,
          body: certificate,
        });
        return certificate;
      }),
    getCertificate: (name) =>
      read("read certificate", async () => {
        const object: unknown = await custom.getNamespacedCustomObject({
          ...CERT_MANAGER,
          namespace,
          name,
        });
        return object as CertificateObject;
      }),
    deleteCertificate: (name) =>
      remove("delete certificate", () =>
        custom.deleteNamespacedCustomObject({
          ...CERT_MANAGER,
          namespace,
          name,
          propagationPolicy: background,
        }),
      ),
    listCertificates: async (labelSelector) => {
      try {
        const list: unknown = await custom.listNamespacedCustomObject({
          ...CERT_MANAGER,
          namespace,
          labelSelector,
        });
        const items = (list as { items?: unknown }).items;
        return Array.isArray(items) ? (items as CertificateObject[]) : [];
      } catch (error) {
        throw toApiError("list certificates", error);
      }
    },
  };
};
