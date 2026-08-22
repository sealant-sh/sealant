/**
 * The Kubernetes API slice the BuildKit builder needs: Jobs, ConfigMaps, Secrets and Pod logs.
 * Same error policy as the runtime adapter's seam; RBAC is the union of both
 * (`deploy/kubernetes/rbac/sealant-worker.yaml`).
 */
import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  type V1ConfigMap,
  type V1Job,
  type V1Pod,
  type V1Secret,
} from "@kubernetes/client-node";

import {
  KubernetesApiError,
  type CreateOutcome,
  type DeleteOutcome,
} from "../../runtime/kubernetes/api.js";

export interface KubernetesBuildApi {
  readonly namespace: string;
  readonly createJob: (job: V1Job) => Promise<CreateOutcome<V1Job>>;
  readonly getJob: (name: string) => Promise<V1Job | undefined>;
  readonly deleteJob: (name: string) => Promise<DeleteOutcome>;
  readonly listJobs: (labelSelector: string) => Promise<readonly V1Job[]>;
  readonly createConfigMap: (configMap: V1ConfigMap) => Promise<CreateOutcome<V1ConfigMap>>;
  readonly deleteConfigMap: (name: string) => Promise<DeleteOutcome>;
  readonly createSecret: (secret: V1Secret) => Promise<CreateOutcome<V1Secret>>;
  readonly deleteSecret: (name: string) => Promise<DeleteOutcome>;
  readonly listPods: (labelSelector: string) => Promise<readonly V1Pod[]>;
  /** Tail of one container's log; empty when unavailable. Never throws. */
  readonly readPodLogTail: (
    podName: string,
    container: string,
    tailLines: number,
  ) => Promise<string>;
}

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

export const createLiveKubernetesBuildApi = (options: {
  readonly namespace: string;
  readonly kubeconfigPath?: string | undefined;
}): KubernetesBuildApi => {
  const kubeConfig = new KubeConfig();
  if (options.kubeconfigPath !== undefined) {
    kubeConfig.loadFromFile(options.kubeconfigPath);
  } else {
    kubeConfig.loadFromCluster();
  }
  const core = kubeConfig.makeApiClient(CoreV1Api);
  const batch = kubeConfig.makeApiClient(BatchV1Api);
  const namespace = options.namespace;
  const background = "Background";

  return {
    namespace,
    createJob: (job) =>
      create("create job", () => batch.createNamespacedJob({ namespace, body: job })),
    getJob: (name) => read("read job", () => batch.readNamespacedJob({ name, namespace })),
    deleteJob: (name) =>
      remove("delete job", () =>
        batch.deleteNamespacedJob({ name, namespace, propagationPolicy: background }),
      ),
    listJobs: async (labelSelector) => {
      try {
        return (await batch.listNamespacedJob({ namespace, labelSelector })).items;
      } catch (error) {
        throw toApiError("list jobs", error);
      }
    },
    createConfigMap: (configMap) =>
      create("create configmap", () =>
        core.createNamespacedConfigMap({ namespace, body: configMap }),
      ),
    deleteConfigMap: (name) =>
      remove("delete configmap", () =>
        core.deleteNamespacedConfigMap({ name, namespace, propagationPolicy: background }),
      ),
    createSecret: (secret) =>
      create("create secret", () => core.createNamespacedSecret({ namespace, body: secret })),
    deleteSecret: (name) =>
      remove("delete secret", () =>
        core.deleteNamespacedSecret({ name, namespace, propagationPolicy: background }),
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
  };
};
