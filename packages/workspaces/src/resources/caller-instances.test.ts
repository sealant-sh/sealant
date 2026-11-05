import { decodeResourceInstanceSpec } from "@sealant/api-contracts";
import { expect, it } from "vitest";

import { parseResourceCallers } from "./caller-config.js";
import { callerGuardScript } from "./docker-caller-runtime.js";
import { callerKubernetesObjects } from "./kubernetes-caller-runtime.js";
import { desiredAttachments, idleVerdict } from "./reach.js";
import { instanceRecord, linkedExecutor, postgresSpec } from "./resource.fixture.js";

const spec = () =>
  postgresSpec({
    idleStopAfterSeconds: null,
    reach: { kind: "caller", caller: "mend", port: 4400, callbackPort: 4401 },
    volumes: [{ name: "data", mountPath: "/app/data", storageBytes: 1024 * 1024 }],
  });

it("caller reach survives arbitrary idle time and excludes even a stale same-scope workspace link", () => {
  const instance = instanceRecord({ spec: spec(), startedAt: new Date(0) });
  expect(desiredAttachments([linkedExecutor("workspace", "tree")], [instance])).toEqual([]);
  for (const years of [1, 10, 100])
    expect(idleVerdict(instance, false, new Date(years * 365 * 86400_000)).kind).toBe("reached");
});

it("requires caller instances to declare retained storage and omit worktree and idle stop", () => {
  for (const change of [
    { idleStopAfterSeconds: 1800 },
    { worktreeKey: "tree" },
    { volumes: [] },
    { volumes: [{ name: "data", mountPath: "/data" }] },
  ]) {
    expect(decodeResourceInstanceSpec({ ...spec(), ...change }).kind).toBe("refused");
  }
  expect(decodeResourceInstanceSpec(spec()).kind).toBe("spec");
  expect(decodeResourceInstanceSpec({ ...spec(), privileged: true }).kind).toBe("refused");
  expect(decodeResourceInstanceSpec({ ...postgresSpec(), idleStopAfterSeconds: null }).kind).toBe(
    "refused",
  );
});

it("requires an explicit callback port allowlist and nonempty Kubernetes caller selector", () => {
  expect(() =>
    parseResourceCallers(
      '[{"kind":"kubernetes","name":"mend","namespace":"mend","host":"mend.mend.svc.cluster.local","podLabels":{},"callbackPorts":[4401]}]',
    ),
  ).toThrow();
  expect(
    parseResourceCallers(
      '[{"kind":"docker","name":"mend","container":"mend","callbackPorts":[4401]}]',
    ),
  ).toHaveLength(1);
});

it("Kubernetes admits only the configured caller, retains PVCs and never mounts credentials", () => {
  const instance = instanceRecord({ spec: spec() });
  const callers = parseResourceCallers(
    '[{"kind":"kubernetes","name":"mend","namespace":"mend","host":"signin.mend.svc.cluster.local","podLabels":{"app":"mend-api"},"callbackPorts":[4401]}]',
  );
  const { statefulSet, volumes, policy, service } = callerKubernetesObjects(instance, {
    namespace: "sealant-services",
    callers,
  });
  expect(statefulSet.spec?.replicas).toBe(1);
  expect(statefulSet.spec?.persistentVolumeClaimRetentionPolicy).toEqual({
    whenDeleted: "Retain",
    whenScaled: "Retain",
  });
  expect(statefulSet.spec?.template.spec?.automountServiceAccountToken).toBe(false);
  expect(statefulSet.spec?.template.spec?.containers[0]?.resources?.limits?.memory).toBe(
    String(instance.spec.limits.memoryBytes),
  );
  expect(volumes[0]?.metadata?.ownerReferences).toBeUndefined();
  expect(policy.spec?.ingress).toEqual([
    {
      _from: [
        {
          namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "mend" } },
          podSelector: { matchLabels: { app: "mend-api" } },
        },
      ],
      ports: [{ protocol: "TCP", port: 4400 }],
    },
  ]);
  expect(policy.spec?.egress?.[0]?.ports).toEqual([{ protocol: "TCP", port: 4401 }]);
  expect(service.spec?.type).toBe("ClusterIP");
  expect(service.spec?.ports).toEqual([
    { name: "service", port: 4400, targetPort: 4400, protocol: "TCP" },
  ]);
});

it("Docker guards deny private and IPv6 egress while admitting exactly one callback", () => {
  const rules = callerGuardScript("10.231.0.2", 4400, 4401);
  expect(rules).toContain("iptables -A INPUT -s 10.231.0.2/32 -p tcp --dport 4400 -j ACCEPT");
  expect(rules).toContain("iptables -A OUTPUT -d 10.231.0.2/32 -p tcp --dport 4401 -j ACCEPT");
  expect(rules).toContain("169.254.0.0/16 -j REJECT");
  expect(rules).toContain("ip6tables -P OUTPUT DROP");
  expect(rules.indexOf("--dport 4401")).toBeLessThan(rules.indexOf("10.0.0.0/8 -j REJECT"));
});
