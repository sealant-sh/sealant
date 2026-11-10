/**
 * Runtime families share the API contract list. Parsing a family does not register its adapter.
 *
 * A family in this list is a *valid request*, not a promise: a deployment registers only the
 * adapters it is configured for, and `selectRuntimeAdapter` answers an unregistered family with a
 * readable "unsupported-runtime" error.
 *
 * - `docker`: containers on the worker's Docker daemon (the default deployment).
 * - `k8s` / `k3s`: workspace Pods on a cluster (k3s differs only in scheduling defaults).
 * - `cloudflare`: Cloudflare Sandboxes driven through a bridge Worker (hosted deployments).
 * - `microvm`: AWS Lambda MicroVMs, one Firecracker VM per workspace, driven with the Lambda
 *   MicroVMs API and reached through the VM's authenticated inbound endpoint.
 * - `boat`: Boat VMs booted from native saved snapshots, on the deployment's own Boat account.
 */
import { runtimeAdapterIds } from "@sealant/api-contracts";
import { z } from "zod";
export { runtimeAdapterIds } from "@sealant/api-contracts";

export const runtimeAdapterIdSchema = z.enum(runtimeAdapterIds);

export type RuntimeAdapterId = z.infer<typeof runtimeAdapterIdSchema>;
