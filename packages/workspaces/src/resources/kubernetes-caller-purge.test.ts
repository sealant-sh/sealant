import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { callerInstanceName } from "./caller-config.js";
import { KubernetesCallerRuntime } from "./kubernetes-caller-runtime.js";
import { instanceRecord, postgresSpec } from "./resource.fixture.js";

const discovery = (groupVersion: string, resources: ReadonlyArray<readonly [string, string]>) => ({
  apiVersion: "v1",
  kind: "APIResourceList",
  groupVersion,
  resources: resources.map(([resource, kind]) => ({
    name: resource,
    kind,
    namespaced: true,
    verbs: ["get", "delete"],
  })),
});

/** The real Kubernetes HTTP client talks to this isolated protocol fixture, never a cluster. */
const fixture = async () => {
  const instance = instanceRecord({
    desired: "stopped",
    stopReason: { kind: "person", by: "purge" },
    spec: postgresSpec({
      idleStopAfterSeconds: null,
      reach: { kind: "caller", caller: "mend", port: 4400, callbackPort: 4401 },
      volumes: [{ name: "data", mountPath: "/app/data", storageBytes: 4096 }],
    }),
  });
  const name = callerInstanceName(instance.id);
  const namespace = "coresvc-test";
  const prefix = `/api/v1/namespaces/${namespace}`;
  const controller = `/apis/apps/v1/namespaces/${namespace}/statefulsets/${name}`;
  const policy = `/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`;
  const metadata = { name, namespace };
  const objects = new Map<string, unknown>([
    [controller, { apiVersion: "apps/v1", kind: "StatefulSet", metadata, spec: { replicas: 0 } }],
    [
      `${prefix}/persistentvolumeclaims/${name}-data`,
      {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { ...metadata, name: `${name}-data` },
        spec: { volumeName: "coresvc-bound" },
      },
    ],
    [
      `${prefix}/secrets/${name}`,
      { apiVersion: "v1", kind: "Secret", metadata, data: { TOKEN: "c3ludGhldGlj" } },
    ],
    [`${prefix}/services/${name}`, { apiVersion: "v1", kind: "Service", metadata }],
    [
      `${prefix}/pods/${name}-backup`,
      { apiVersion: "v1", kind: "Pod", metadata: { ...metadata, name: `${name}-backup` } },
    ],
    [`${policy}/${name}`, { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata }],
    [
      `${policy}/${name}-backup`,
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { ...metadata, name: `${name}-backup` },
      },
    ],
    [
      `${prefix}/secrets/coresvc-unrelated`,
      { apiVersion: "v1", kind: "Secret", metadata: { name: "coresvc-unrelated", namespace } },
    ],
  ]);
  const volume = {
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: { name: "coresvc-bound" },
    spec: {
      persistentVolumeReclaimPolicy: "Delete",
      claimRef: { name: `${name}-data`, namespace },
    },
  };
  const state = { volumes: [volume], failDelete: "", reclaimReads: 0 };
  const deletes: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    response.setHeader("content-type", "application/json");
    const answer = (body: unknown) => response.end(JSON.stringify(body));
    if (path === "/api/v1")
      return answer(
        discovery("v1", [
          ["pods", "Pod"],
          ["secrets", "Secret"],
          ["services", "Service"],
          ["persistentvolumeclaims", "PersistentVolumeClaim"],
        ]),
      );
    if (path === "/apis/apps/v1")
      return answer(discovery("apps/v1", [["statefulsets", "StatefulSet"]]));
    if (path === "/apis/networking.k8s.io/v1")
      return answer(discovery("networking.k8s.io/v1", [["networkpolicies", "NetworkPolicy"]]));
    if (path === "/api/v1/persistentvolumes") {
      // Reclaim can outlive the PVC. A retry must still find its claim ref.
      if (!objects.has(`${prefix}/persistentvolumeclaims/${name}-data`) && state.reclaimReads++ > 0)
        state.volumes = [];
      return answer({ apiVersion: "v1", kind: "PersistentVolumeList", items: state.volumes });
    }
    if (request.method === "DELETE") {
      deletes.push(path);
      if (state.failDelete === path) {
        response.statusCode = 403;
        return answer({
          kind: "Status",
          code: 403,
          reason: "Forbidden",
          message: "synthetic forbidden",
        });
      }
      if (objects.delete(path)) return answer({ kind: "Status", status: "Success" });
    } else if (objects.has(path)) return answer(objects.get(path));
    response.statusCode = 404;
    return answer({ kind: "Status", code: 404, reason: "NotFound", message: "absent" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture port.");
  const scratch = await mkdtemp(join(tmpdir(), "coresvc-k8s-purge-"));
  const config = join(scratch, "kubeconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "fixture",
          cluster: { server: `http://127.0.0.1:${address.port}`, "insecure-skip-tls-verify": true },
        },
      ],
      contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
      "current-context": "fixture",
      users: [{ name: "fixture", user: {} }],
    }),
  );
  const runtime = new KubernetesCallerRuntime({
    namespace,
    callers: [],
    networkPolicyEnforced: false,
    kubeconfigPath: config,
  });
  const close = async () => {
    const closed = once(server, "close");
    server.close();
    await closed;
    console.info("Removing owned test scratch:", scratch, await readdir(scratch));
    await rm(scratch, { recursive: true });
  };
  return { instance, runtime, objects, deletes, state, close, name, prefix, controller, policy };
};

it("purges only owned Kubernetes objects, waits for storage reclaim, and accepts a repeat", async () => {
  const f = await fixture();
  try {
    await f.runtime.purge(f.instance);
    expect([...f.objects.keys()]).toEqual([`${f.prefix}/secrets/coresvc-unrelated`]);
    expect(f.state.volumes).toEqual([]);
    expect(f.state.reclaimReads).toBeGreaterThan(1);
    expect(f.deletes.indexOf(f.controller)).toBeLessThan(
      f.deletes.indexOf(`${f.prefix}/persistentvolumeclaims/${f.name}-data`),
    );
    expect(f.deletes.at(-1)).toBe(`${f.policy}/${f.name}`);
    await f.runtime.purge(f.instance);
  } finally {
    await f.close();
  }
});

it("refuses a running pod, an active StatefulSet, and Retain-policy data before deleting anything", async () => {
  const f = await fixture();
  try {
    const pod = `${f.prefix}/pods/${f.name}-0`;
    f.objects.set(pod, { apiVersion: "v1", kind: "Pod", metadata: { name: `${f.name}-0` } });
    await expect(f.runtime.purge(f.instance)).rejects.toMatchObject({
      _tag: "ResourceInstancePurgeRefusedError",
    });
    f.objects.delete(pod);
    f.objects.set(f.controller, {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      spec: { replicas: 1 },
    });
    await expect(f.runtime.purge(f.instance)).rejects.toMatchObject({
      _tag: "ResourceInstancePurgeRefusedError",
    });
    f.objects.delete(f.controller);
    const volume = f.state.volumes[0];
    if (volume === undefined) throw new Error("Missing fixture volume.");
    volume.spec.persistentVolumeReclaimPolicy = "Retain";
    await expect(f.runtime.purge(f.instance)).rejects.toMatchObject({
      _tag: "ResourceInstancePurgeRefusedError",
    });
    expect(f.deletes).toEqual([]);
  } finally {
    await f.close();
  }
});

it("keeps deletion failures visible and resumes cleanup after a provider failure", async () => {
  const f = await fixture();
  try {
    f.state.failDelete = `${f.prefix}/persistentvolumeclaims/${f.name}-data`;
    await expect(f.runtime.purge(f.instance)).rejects.toThrow("could not be removed");
    expect(f.objects.has(f.state.failDelete)).toBe(true);
    expect(f.objects.has(`${f.policy}/${f.name}`)).toBe(true);
    f.state.failDelete = "";
    await f.runtime.purge(f.instance);
    expect([...f.objects.keys()]).toEqual([`${f.prefix}/secrets/coresvc-unrelated`]);
  } finally {
    await f.close();
  }
});

it("finds Retain-policy storage by claim ref even after its PVC was deleted", async () => {
  const f = await fixture();
  try {
    f.objects.delete(`${f.prefix}/persistentvolumeclaims/${f.name}-data`);
    const volume = f.state.volumes[0];
    if (volume === undefined) throw new Error("Missing fixture volume.");
    volume.spec.persistentVolumeReclaimPolicy = "Retain";
    await expect(f.runtime.purge(f.instance)).rejects.toMatchObject({
      _tag: "ResourceInstancePurgeRefusedError",
    });
    expect(f.deletes).toEqual([]);
  } finally {
    await f.close();
  }
});
