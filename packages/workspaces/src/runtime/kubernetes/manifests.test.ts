/**
 * Pins the manifests the adapter emits for the Mend-style mount launch. Anything that changes
 * here changes what runs in a cluster — the Pod security posture in particular is asserted field
 * by field so it cannot drift silently.
 */
import { describe, expect, it } from "vitest";

import { cases } from "../docker-runtime-adapter.golden-fixture.js";
import { collectMountIntents } from "../mount-intent.js";
import { kubernetesRuntimeConfigSchema, type KubernetesRuntimeConfig } from "./config.js";
import {
  buildCertificate,
  buildEnvSecret,
  buildLaunchSecret,
  buildPod,
  buildService,
  plainEnvEntries,
  secretEnvEntries,
  workspaceLabels,
} from "./manifests.js";
import { workspaceResourceNames } from "./names.js";
import { lowerMountIntents } from "./volumes.js";

const config: KubernetesRuntimeConfig = kubernetesRuntimeConfigSchema.parse({
  namespace: "sealant-workspaces",
  volumeMappings: [
    { logicalRoot: "/var/lib/mend/store", claimName: "mend-store" },
    { logicalRoot: "/run/sealant/sockets/_dotfiles", claimName: "sealant-staging" },
  ],
  resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "4", memory: "8Gi" } },
  certManagerIssuer: { name: "sealant-internal" },
  imagePullSecret: "ghcr-pull",
  workspacePriorityClass: "sealant-workspace",
  gvisorRuntimeClass: "gvisor",
});

const input = {
  ...cases.mendMount,
  secretEnv: { OPENAI_API_KEY: "sk-secret" },
  workspaceId: "ws_1",
  principalId: "user_1",
};
const runId = input.runId ?? "run-golden-2";
const names = workspaceResourceNames(runId);
const labels = workspaceLabels(config, {
  runId,
  adapter: "k8s",
  workspaceId: "ws_1",
  principalId: "user_1",
});

describe("Kubernetes manifests", () => {
  it("labels every object with the reconciliation keys and nothing secret", () => {
    expect(labels).toEqual({
      "app.kubernetes.io/managed-by": "sealant",
      "app.kubernetes.io/component": "workspace",
      "sealant.sh/run-id": "run-golden-2",
      "sealant.sh/runtime-adapter": "k8s",
      "sealant.sh/workspace-id": "ws_1",
      "sealant.sh/principal": "user_1",
    });
  });

  it("keeps plain env in Docker precedence order and adds only the WSS + boot-file contract", () => {
    const plain = plainEnvEntries(input, config, {
      secretEnvFile: true,
      dotfilesArchiveDir: "/run/sealant/launch/dotfiles",
    });
    expect(plain).toEqual([
      ["EDITOR", "vim"],
      ["SEALANT_WORKSPACE_SOURCE", "mount"],
      ["SEALANT_WORKSPACE_MOUNT_HOST_PATH", "/var/lib/mend/store/acme/worktrees/session-1"],
      ["SEALANT_MOUNT_ALLOWED_STORE_ROOTS", "/var/lib/mend/store:/run/sealant/sockets/_dotfiles"],
      ["SEALANT_OCI_RUNTIME", "runsc"],
      ["SEALANT_HARNESS_BANNER", "Starting claude-code workspace"],
      ["SEALANT_HARNESS_LAUNCH_COMMAND", "claude"],
      ["MEND_SESSION_ID", "1"],
      ["SEALANT_CONTROL_WSS_LISTEN", "0.0.0.0:7443"],
      ["SEALANT_CONTROL_WSS_CERT", "/run/sealant/tls/tls.crt"],
      ["SEALANT_CONTROL_WSS_KEY", "/run/sealant/tls/tls.key"],
      ["SEALANT_CONTROL_WSS_CLIENT_CA", "/run/sealant/tls/ca.crt"],
      ["SEALANT_SECRET_ENV_FILE", "/run/sealant/launch/env.json"],
      ["SEALANT_DOTFILES_ARCHIVE_DIR", "/run/sealant/launch/dotfiles"],
    ]);
  });

  it("renders a standby source and its binds for the daemon", () => {
    const plain = plainEnvEntries(
      {
        ...input,
        blueprint: {
          ...input.blueprint,
          sources: {
            ...input.blueprint.sources,
            workspace: { kind: "standby", rootPath: "/var/lib/mend/store/acme/worktrees" },
            mounts: [
              {
                hostPath: "/var/lib/mend/store/api/worktrees",
                mountPath: "/workspace/repos/api",
                readOnly: false,
                bindable: true,
              },
            ],
          },
        },
        binds: [{ mountPath: "/workspace/repo", subpath: "wt-1" }],
      },
      config,
      { secretEnvFile: false, dotfilesArchiveDir: undefined },
    );
    expect(plain).toEqual(
      expect.arrayContaining([
        ["SEALANT_WORKSPACE_SOURCE", "standby"],
        ["SEALANT_WORKSPACE_MOUNT_HOST_PATH", "/var/lib/mend/store/acme/worktrees"],
        [
          "SEALANT_BINDABLE_MOUNTS",
          JSON.stringify([
            {
              mountPath: "/workspace/repos/api",
              rootMountPath: "/workspace/.roots/workspace__repos__api",
              hostRootPath: "/var/lib/mend/store/api/worktrees",
            },
          ]),
        ],
        ["SEALANT_BINDS", JSON.stringify([{ mountPath: "/workspace/repo", subpath: "wt-1" }])],
      ]),
    );
    expect(plain.some(([key]) => key === "SEALANT_WORKSPACE_REPO_URL")).toBe(false);
  });

  it("routes secret-bearing env through a Secret, credential env last", () => {
    const entries = secretEnvEntries(
      {
        workspaceCloneAuth: { type: "http-token", username: "x-access-token", token: "ghs_x" },
        platformEnv: { SEALANT_DOTFILES_HTTP_TOKEN: "dot" },
        credentialEnv: { GITHUB_TOKEN: "gh" },
      },
      undefined,
    );
    expect(entries).toEqual([
      ["SEALANT_WORKSPACE_HTTP_USERNAME", "x-access-token"],
      ["SEALANT_WORKSPACE_HTTP_TOKEN", "ghs_x"],
      ["SEALANT_DOTFILES_HTTP_TOKEN", "dot"],
      ["GITHUB_TOKEN", "gh"],
    ]);
    const secret = buildEnvSecret(names, config.namespace, labels, entries);
    expect(secret?.data).toEqual({
      SEALANT_WORKSPACE_HTTP_USERNAME: Buffer.from("x-access-token").toString("base64"),
      SEALANT_WORKSPACE_HTTP_TOKEN: Buffer.from("ghs_x").toString("base64"),
      SEALANT_DOTFILES_HTTP_TOKEN: Buffer.from("dot").toString("base64"),
      GITHUB_TOKEN: Buffer.from("gh").toString("base64"),
    });
    expect(buildEnvSecret(names, config.namespace, labels, [])).toBeUndefined();
  });

  it("projects env.json and small dotfiles into the launch Secret", () => {
    const secret = buildLaunchSecret(names, config.namespace, labels, {
      secretEnvJson: '{"OPENAI_API_KEY":"sk-secret"}',
      dotfiles: { manifestJson: '{"archives":[]}\n', archives: [Buffer.from("tar")] },
    });
    expect(secret?.metadata?.name).toBe(names.launchSecret);
    expect(Object.keys(secret?.data ?? {})).toEqual([
      "env.json",
      "dotfiles-manifest",
      "dotfiles-0",
    ]);
    expect(buildLaunchSecret(names, config.namespace, labels, {})).toBeUndefined();
  });

  it("requests a server-auth-only certificate for the Service DNS name", () => {
    const certificate = buildCertificate(names, config, labels);
    expect(certificate.spec.dnsNames).toEqual([
      `${names.service}.sealant-workspaces.svc`,
      `${names.service}.sealant-workspaces.svc.cluster.local`,
    ]);
    expect(certificate.spec.usages).toEqual([
      "server auth",
      "digital signature",
      "key encipherment",
    ]);
    expect(certificate.spec.usages).not.toContain("client auth");
    expect(certificate.spec.secretName).toBe(names.tlsSecret);
    expect(certificate.spec.issuerRef).toEqual({
      name: "sealant-internal",
      kind: "Issuer",
      group: "cert-manager.io",
    });
  });

  it("builds a ClusterIP Service selecting this run's Pod on the control port", () => {
    const service = buildService(names, config, labels, runId);
    expect(service.spec).toEqual({
      type: "ClusterIP",
      selector: {
        "app.kubernetes.io/managed-by": "sealant",
        "app.kubernetes.io/component": "workspace",
        "sealant.sh/run-id": "run-golden-2",
      },
      ports: [{ name: "control", port: 7443, targetPort: "control", protocol: "TCP" }],
    });
  });

  it("builds the Pod with the documented security posture, mounts and env", () => {
    const lowered = lowerMountIntents(
      collectMountIntents({
        blueprint: input.blueprint,
        dotfilesArchiveDir: undefined,
        secretEnvDir: undefined,
      }),
      config.volumeMappings,
    );
    const launchSecret = buildLaunchSecret(names, config.namespace, labels, {
      secretEnvJson: "{}",
      dotfiles: { manifestJson: "{}", archives: [Buffer.from("a")] },
    });
    const pod = buildPod({
      names,
      config,
      labels,
      input,
      lowered,
      plainEnv: [
        ["A", "1"],
        ["GITHUB_TOKEN", "plaintext-should-lose"],
      ],
      secretEnvKeys: ["GITHUB_TOKEN"],
      launchSecret,
      priorityClassName: "sealant-workspace",
    });

    expect(pod.metadata).toEqual({ name: names.pod, namespace: "sealant-workspaces", labels });
    expect(pod.spec?.restartPolicy).toBe("Never");
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
    expect(pod.spec?.serviceAccountName).toBe("sealant-workspace");
    expect(pod.spec?.enableServiceLinks).toBe(false);
    expect(pod.spec?.priorityClassName).toBe("sealant-workspace");
    expect(pod.spec?.runtimeClassName).toBe("gvisor");
    expect(pod.spec?.imagePullSecrets).toEqual([{ name: "ghcr-pull" }]);
    expect(pod.spec?.securityContext).toEqual({ seccompProfile: { type: "RuntimeDefault" } });
    expect(pod.spec?.topologySpreadConstraints?.[0]?.topologyKey).toBe("kubernetes.io/hostname");

    const container = pod.spec?.containers[0];
    expect(container?.image).toBe(input.publishedImage.digestReference);
    expect(container?.workingDir).toBe("/workspace/repo");
    expect(container?.securityContext).toEqual({
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: false,
      capabilities: {
        drop: ["ALL"],
        add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "KILL"],
      },
    });
    expect(container?.ports).toEqual([{ name: "control", containerPort: 7443, protocol: "TCP" }]);
    expect(container?.resources).toEqual({
      requests: { cpu: "500m", memory: "1Gi" },
      limits: { cpu: "4", memory: "8Gi" },
    });
    // Secret-backed env wins over a same-named plaintext entry and appears once.
    expect(container?.env).toEqual([
      { name: "A", value: "1" },
      {
        name: "GITHUB_TOKEN",
        valueFrom: { secretKeyRef: { name: names.envSecret, key: "GITHUB_TOKEN" } },
      },
    ]);
    expect(JSON.stringify(pod)).not.toContain("plaintext-should-lose");

    expect(pod.spec?.volumes).toEqual([
      { name: "run-sealant", emptyDir: {} },
      { name: "tls", secret: { secretName: names.tlsSecret, defaultMode: 0o400 } },
      { name: "store-0", persistentVolumeClaim: { claimName: "mend-store" } },
      {
        name: "launch",
        secret: {
          secretName: names.launchSecret,
          defaultMode: 0o400,
          items: [
            { key: "env.json", path: "env.json" },
            { key: "dotfiles-manifest", path: "dotfiles/manifest.json" },
            { key: "dotfiles-0", path: "dotfiles/0.tar.gz" },
          ],
        },
      },
    ]);
    expect(container?.volumeMounts).toEqual([
      { name: "run-sealant", mountPath: "/run/sealant" },
      { name: "tls", mountPath: "/run/sealant/tls", readOnly: true },
      {
        name: "store-0",
        mountPath: "/workspace/repo",
        subPath: "acme/worktrees/session-1",
        readOnly: false,
      },
      {
        name: "store-0",
        mountPath: "/var/lib/mend/store/acme/repo.git",
        subPath: "acme/repo.git",
        readOnly: false,
      },
      {
        name: "store-0",
        mountPath: "/workspace/ref/lib",
        subPath: "_references/lib",
        readOnly: true,
      },
      { name: "store-0", mountPath: "/run/mend", subPath: "_run/sessions/1", readOnly: true },
      { name: "launch", mountPath: "/run/sealant/launch", readOnly: true },
    ]);
  });

  it("omits runtimeClassName for runc and topology spread when disabled", () => {
    const pod = buildPod({
      names,
      config: { ...config, topologySpread: false },
      labels,
      input: cases.gitSource,
      lowered: { volumes: [], volumeMounts: [] },
      plainEnv: [],
      secretEnvKeys: [],
      launchSecret: undefined,
      priorityClassName: undefined,
    });
    expect(pod.spec?.runtimeClassName).toBeUndefined();
    expect(pod.spec?.topologySpreadConstraints).toBeUndefined();
    expect(pod.spec?.priorityClassName).toBeUndefined();
    expect(pod.spec?.volumes?.map((v) => v.name)).toEqual(["run-sealant", "tls"]);
    // No Docker service requested: no user namespace, no sidecar, no alias, no DOCKER_HOST.
    expect(pod.spec?.hostUsers).toBeUndefined();
    expect(pod.spec?.hostAliases).toBeUndefined();
    expect(pod.spec?.initContainers).toBeUndefined();
    expect(JSON.stringify(pod)).not.toContain("DOCKER_HOST");
  });

  it("runs the Docker service as a rootless sidecar inside a user-namespaced Pod", () => {
    const dockerConfig: KubernetesRuntimeConfig = {
      ...config,
      docker: { ...config.docker, enabled: true },
    };
    // A legacy `runtime.env` DOCKER_HOST must lose to the adapter-owned socket (last wins).
    const dockerInput = {
      ...cases.dind,
      blueprint: {
        ...cases.dind.blueprint,
        runtime: { ...cases.dind.blueprint.runtime, env: { DOCKER_HOST: "tcp://elsewhere:2375" } },
      },
    };
    const plain = plainEnvEntries(dockerInput, dockerConfig, {
      secretEnvFile: false,
      dotfilesArchiveDir: undefined,
    });
    expect(plain.filter(([key]) => key === "DOCKER_HOST").at(-1)).toEqual([
      "DOCKER_HOST",
      "unix:///run/docker/docker.sock",
    ]);
    expect(plain).toContainEqual(["DOCKER_TLS_CERTDIR", ""]);

    const pod = buildPod({
      names,
      config: dockerConfig,
      labels,
      input: dockerInput,
      lowered: { volumes: [], volumeMounts: [] },
      plainEnv: plain,
      secretEnvKeys: [],
      launchSecret: undefined,
      priorityClassName: undefined,
    });
    expect(pod.spec?.hostUsers).toBe(false);
    expect(pod.spec?.hostAliases).toEqual([{ ip: "127.0.0.1", hostnames: ["docker"] }]);
    // Pod-level seccomp stays; only the sidecar is privileged (and only inside the namespace).
    expect(pod.spec?.securityContext).toEqual({ seccompProfile: { type: "RuntimeDefault" } });

    const sidecar = pod.spec?.initContainers?.[0];
    expect(pod.spec?.initContainers).toHaveLength(1);
    expect(sidecar).toMatchObject({
      name: "docker",
      image: "docker:28.5.2-dind-rootless",
      restartPolicy: "Always",
      env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
      securityContext: { privileged: true, runAsUser: 0 },
      startupProbe: {
        exec: { command: ["docker", "-H", "unix:///run/docker/docker.sock", "info"] },
      },
      resources: {
        requests: { cpu: "100m", memory: "256Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      },
      volumeMounts: [
        { name: "docker-run", mountPath: "/run/docker" },
        { name: "docker-graph", mountPath: "/home/rootless/.local/share/docker" },
      ],
    });
    const script = sidecar?.command?.[2] ?? "";
    expect(sidecar?.command?.slice(0, 2)).toEqual(["/bin/sh", "-ec"]);
    expect(script).toContain("echo 'rootless:1001:64533' > /etc/subuid");
    expect(script).toContain(
      "exec dockerd-entrypoint.sh dockerd --host=unix:///run/docker/docker.sock --data-root=/home/rootless/.local/share/docker",
    );
    expect(script).not.toContain("tcp://");

    expect(pod.spec?.volumes).toEqual([
      { name: "run-sealant", emptyDir: {} },
      { name: "tls", secret: { secretName: names.tlsSecret, defaultMode: 0o400 } },
      { name: "docker-run", emptyDir: {} },
      { name: "docker-graph", emptyDir: { sizeLimit: "20Gi" } },
    ]);

    const workspace = pod.spec?.containers[0];
    expect(workspace?.securityContext).toEqual({
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: false,
      capabilities: {
        drop: ["ALL"],
        add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "KILL"],
      },
    });
    expect(workspace?.volumeMounts).toContainEqual({
      name: "docker-run",
      mountPath: "/run/docker",
    });
    expect(workspace?.volumeMounts?.some((mount) => mount.name === "docker-graph")).toBe(false);
    expect(workspace?.env?.filter((entry) => entry.name === "DOCKER_HOST")).toEqual([
      { name: "DOCKER_HOST", value: "unix:///run/docker/docker.sock" },
    ]);
  });
});
