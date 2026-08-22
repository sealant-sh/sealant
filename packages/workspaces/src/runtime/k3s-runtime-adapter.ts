/**
 * The `k3s` runtime family: the same Kubernetes implementation with a single-node-friendly
 * profile — no topology spread unless the operator turned it on explicitly. Nothing else differs;
 * k3s is Kubernetes.
 */
import {
  KubernetesRuntimeAdapter,
  type KubernetesRuntimeAdapterOptions,
} from "./kubernetes/adapter.js";

export class K3sRuntimeAdapter extends KubernetesRuntimeAdapter {
  constructor(options: Omit<KubernetesRuntimeAdapterOptions, "id">) {
    super({
      ...options,
      id: "k3s",
      config: { ...options.config, topologySpread: options.config.topologySpread && false },
    });
  }
}
