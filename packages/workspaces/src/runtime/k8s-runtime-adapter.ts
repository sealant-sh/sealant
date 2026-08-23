/**
 * The `k8s` runtime family: the shared Kubernetes implementation with the default profile
 * (topology spread on, PriorityClasses as configured). See `kubernetes/adapter.ts`.
 */
import {
  KubernetesRuntimeAdapter,
  type KubernetesRuntimeAdapterOptions,
} from "./kubernetes/adapter.js";

export class K8sRuntimeAdapter extends KubernetesRuntimeAdapter {
  constructor(options: Omit<KubernetesRuntimeAdapterOptions, "id">) {
    super({ ...options, id: "k8s" });
  }
}
