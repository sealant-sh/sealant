/**
 * The per-person layout on Kubernetes under runc, end to end on the kind cluster (Mend's ADR 0016,
 * decision 1; the owner map on Kubernetes).
 *
 * Gated on SEALANT_K8S_E2E=1 with a cluster from `deploy/e2e/kind/up.sh`.
 * `SEALANT_PERSON_LAYOUT_E2E_FAMILY` picks the image family (default `fedora`).
 * `SEALANT_PERSON_LAYOUT_E2E_EVIDENCE_DIR`, when set, receives `evidence.log` and each workspace
 * Pod's YAML. The capture channel (`capture-channel.fixture.ts`) runs in a Node container on the
 * `kind` Docker network, where Pods reach it: a host firewall may drop what a kind node sends to
 * the host itself.
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { V1Pod } from "@kubernetes/client-node";
import { StreamKind } from "@sealant/runtime-client";
import type { EventEnvelope } from "@sealant/runtime-protocol";
import {
  parseWorkspaceBlueprint,
  parseWorkspaceImageProbe,
  type WorkspaceBlueprint,
} from "@sealant/validators";
import { Effect, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NIX_PROFILE, imagePersonLayoutSupport } from "../buildkit/person-layout.js";
import { KubernetesRuntimeAdapter } from "../runtime/kubernetes/adapter.js";
import { createLiveKubernetesApi, type KubernetesApi } from "../runtime/kubernetes/api.js";
import { kubernetesRuntimeConfigSchema } from "../runtime/kubernetes/config.js";
import type { PublishedImage, RuntimeAdapterLaunchInput } from "../runtime/runtime-adapter.js";
import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantSession,
  type SealantTarget,
} from "../sealantd/runtime.js";
import {
  buildWorkspaceImage,
  clientTls,
  E2E_ENABLED,
  forwardedControlChannel,
  kubectl,
  NAMESPACE,
  probeUserNamespaces,
  startRegistryForward,
  withForwardedTarget,
  type RegistryForward,
  type UserNamespaceSupport,
} from "./e2e-support.js";

const execFileAsync = promisify(execFile);

const FAMILY = process.env["SEALANT_PERSON_LAYOUT_E2E_FAMILY"] ?? "fedora";
const EVIDENCE_DIR = process.env["SEALANT_PERSON_LAYOUT_E2E_EVIDENCE_DIR"];
const SUFFIX = Date.now().toString(36);
const CAPTURE_TOKEN = "person-layout-e2e-token";
const WORKTREE_ID = `person-layout-e2e-${SUFFIX}`;
const REPO = "/workspace/repo";
const MEND_GID = 40000;
const ALICE = { name: "m4lice000", uid: 40001, account: "acct_alice" };
const BOB = { name: "m8ob0000", uid: 40002, account: "acct_bob" };
const PEOPLE = [ALICE, BOB] as const;
const OWNER_MAP = {
  gid: MEND_GID,
  worktreeUid: ALICE.uid,
  people: PEOPLE.map((person) => ({ id: person.account, uid: person.uid })),
};

const evidence = (step: string, value: unknown): void => {
  const line = `[person-layout e2e] ${step}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  console.log(line);
  if (EVIDENCE_DIR !== undefined) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    appendFileSync(join(EVIDENCE_DIR, "evidence.log"), `${new Date().toISOString()} ${line}\n`);
  }
};

const blueprintFor = (input: {
  readonly endpoint: string;
  readonly ownerMap?: typeof OWNER_MAP | { gid: number; worktreeUid: number; people: [] };
  readonly docker: boolean;
  readonly ociRuntime?: "runc" | "runsc";
}): WorkspaceBlueprint =>
  parseWorkspaceBlueprint({
    version: "1",
    sources: {
      workspace: {
        kind: "capture",
        endpoint: input.endpoint,
        worktreeId: WORKTREE_ID,
        transport: { plaintext: true },
        ...(input.ownerMap === undefined ? {} : { ownerMap: input.ownerMap }),
      },
      inputs: [],
      mounts: [],
    },
    harness: { id: "codex" },
    access: { ssh: { enabled: false, listenPort: 2222 } },
    tooling: {
      packages: [],
      ...(input.docker ? { services: { docker: { enabled: true } } } : {}),
    },
    customization: {
      defaultShell: "bash",
      dotfilesManager: "auto",
      dotfilesTarget: "home",
      applyDotfiles: false,
      dotfilesBootstrap: false,
    },
    lifecycle: {
      setup: [],
      startup: { steps: [], foreground: { kind: "command", run: "sleep infinity", shell: "sh" } },
    },
    runtime: {
      env: {},
      workspaceRoot: "/workspace",
      workingDirectory: REPO,
      persistence: "ephemeral",
      ociRuntime: input.ociRuntime ?? "runc",
      network: { outbound: true },
    },
    target: {
      runtime: { family: "k8s", mode: "require" },
      os: { family: FAMILY, mode: "require" },
    },
  });

const withDaemon = <A, E>(
  target: SealantTarget,
  use: (session: SealantSession) => Effect.Effect<A, E>,
): Promise<A> =>
  withForwardedTarget(target, (forwarded) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const session = yield* runtime.connect(forwarded);
          return yield* use(session);
        }),
      ).pipe(Effect.provide(SealantRuntimeControlLive)),
    ),
  );

const exec = (
  target: SealantTarget,
  script: string,
  user?: string,
): Promise<{ output: string; exitCode: number | undefined }> =>
  withDaemon(target, (session) =>
    Effect.gen(function* () {
      const accepted = yield* session.exec({
        executable: "/bin/sh",
        args: ["-c", `exec 2>&1\n${script}`],
        cwd: REPO,
        stdin: false,
        ...(user === undefined ? {} : { user }),
      });
      const events = yield* session.events.pipe(
        Stream.filter((event: EventEnvelope) => event.processId === accepted.processId),
        Stream.takeUntil((event: EventEnvelope) => event.payload.case === "processExited"),
        Stream.runCollect,
      );
      let output = "";
      let exitCode: number | undefined;
      for (const event of events) {
        const payload = event.payload;
        if (
          payload.case === "ioChunk" &&
          (payload.value.stream === StreamKind.STDOUT ||
            payload.value.stream === StreamKind.STDERR) &&
          payload.value.content !== undefined
        ) {
          output += Buffer.from(payload.value.content).toString("utf8");
        } else if (payload.case === "processExited") {
          exitCode = payload.value.exitCode;
        }
      }
      return { output, exitCode };
    }),
  );

/** A copy of Mend's prepare (`personHomeFunction` in Mend's harness-layout.ts), run as root. */
const PREPARE_PEOPLE = [
  "set -e",
  `grep -q '^mend:' /etc/group || groupadd -g ${String(MEND_GID)} mend`,
  `sh_=$(awk -F: '$1=="root" { print $7 }' /etc/passwd); [ -n "$sh_" ] || sh_=/bin/sh`,
  `extra=; grep -q '^docker:' /etc/group && extra="-G docker"`,
  `for p in ${PEOPLE.map((person) => `${person.name}:${String(person.uid)}`).join(" ")}; do`,
  `  n=\${p%%:*}; u=\${p#*:}; h=/home/$n`,
  `  if id -u "$n" >/dev/null 2>&1; then [ "$(id -u "$n")" = "$u" ]; continue; fi`,
  `  mkdir -p /home; [ -d "$h" ] || mkdir -m 0700 "$h"; chown "$u:${String(MEND_GID)}" "$h"`,
  `  useradd -u "$u" -g mend $extra -m -k /etc/skel -d "$h" -s "$sh_" "$n"`,
  `  if [ -d /etc/skel ]; then cp -an /etc/skel/. "$h"/ || true; fi`,
  `  chown -hR "$u:${String(MEND_GID)}" "$h"; chmod 0700 "$h"`,
  "done",
  `getent passwd ${PEOPLE.map((person) => String(person.uid)).join(" ")}`,
  `id ${ALICE.name}`,
].join("\n");

const preparePeople = async (target: SealantTarget, phase: string): Promise<void> => {
  const prepared = await exec(target, PREPARE_PEOPLE);
  evidence(`${phase} people prepared (exit ${String(prepared.exitCode)})`, prepared.output.trim());
  expect(prepared.exitCode).toBe(0);
  for (const person of PEOPLE) {
    expect(prepared.output).toContain(
      `${person.name}:x:${String(person.uid)}:${String(MEND_GID)}:`,
    );
  }
};

const checkPeople = async (target: SealantTarget, phase: string): Promise<void> => {
  for (const person of PEOPLE) {
    const seen = await exec(
      target,
      [
        `echo "home=$(getent passwd "$(id -u)" | cut -d: -f6)"`,
        `echo "id=$(id)"`,
        "grep NoNewPrivs /proc/self/status",
        `echo "sudo=$(sudo -n id -u)"`,
      ].join("\n"),
      person.name,
    );
    evidence(`${phase} as ${person.name} (exit ${String(seen.exitCode)})`, seen.output.trim());
    expect(seen.output).toContain(`home=/home/${person.name}`);
    expect(seen.output).toContain(`id=uid=${String(person.uid)}(${person.name})`);
    expect(seen.output).toMatch(/NoNewPrivs:\s*0/);
    expect(seen.output).toContain("sudo=0");
  }
  // Recorded: the Pod adds neither SETFCAP nor AUDIT_WRITE (WORKSPACE_CAPABILITIES).
  const caps = await exec(
    target,
    [
      "grep -E '^Cap(Eff|Bnd)' /proc/self/status",
      "command -v setcap || echo 'setcap: not installed'",
      "sudo -n sh -c 'cp /bin/true /tmp/setfcap-probe && setcap cap_net_bind_service+ep /tmp/setfcap-probe && getcap /tmp/setfcap-probe'",
      `echo "setcap-exit=$?"`,
      "sudo -n true",
      `echo "sudo-true-exit=$?"`,
    ].join("\n"),
    ALICE.name,
  );
  evidence(`${phase} SETFCAP / AUDIT_WRITE probe as ${ALICE.name}`, caps.output.trim());

  const setgid = await exec(
    target,
    [
      "d=/workspace/setgid-probe",
      'rm -rf "$d"; mkdir "$d"',
      `chgrp ${String(MEND_GID)} "$d"`,
      'chmod 2775 "$d"',
      'stat -c "mode=%a" "$d"',
    ].join("\n"),
  );
  evidence(`${phase} root chmod 2775 on a mend-group directory`, setgid.output.trim());
  expect(setgid.output).toContain("mode=2775");
};

const checkDocker = async (target: SealantTarget, phase: string): Promise<void> => {
  const script = [
    `echo "DOCKER_HOST=\${DOCKER_HOST:-unset}"`,
    "ls -lnd /run/docker /run/docker/docker.sock",
    "export DOCKER_HOST=${DOCKER_HOST:-unix:///run/docker/docker.sock}",
    "docker info --format 'server={{.ServerVersion}}'",
    `echo "info-exit=$?"`,
    "docker run --rm alpine:3.20 echo nested-ok",
    `echo "run-exit=$?"`,
  ].join("\n");
  const root = await exec(target, script);
  evidence(`${phase} docker as root`, root.output.trim());
  const people = [];
  for (const person of PEOPLE) {
    const seen = await exec(target, script, person.name);
    evidence(`${phase} docker as ${person.name}`, seen.output.trim());
    people.push(seen.output);
  }
  // The image's `docker info --format` exited 0 on a refused socket; an empty version is the tell.
  for (const output of [root.output, ...people]) {
    expect(output).toMatch(/^server=\S+$/m);
    expect(output).toMatch(/^nested-ok$/m);
  }
};

const NIX = "nix --extra-experimental-features nix-command";
const NIX_BIN = `${NIX_PROFILE}/bin`;

const uncachedDerivation = (who: string, seed: string): string =>
  [
    "derivation {",
    `  name = "pl-${who}-${seed}";`,
    "  system = builtins.currentSystem;",
    `  builder = "${NIX_BIN}/bash";`,
    `  who = "${who}";`,
    `  seed = "${seed}";`,
    "  args = [ \"-c\" ''",
    "    start=$EPOCHREALTIME",
    `    ${NIX_BIN}/mkdir -p $out/bin`,
    "    printf '#!/bin/sh\\necho %s\\n' \"$seed\" > $out/bin/pl-$who",
    `    ${NIX_BIN}/chmod +x $out/bin/pl-$who`,
    `    ${NIX_BIN}/sleep 3`,
    '    printf \'seed=%s builder-uid=%s start=%s end=%s\\n\' "$seed" "$UID" "$start" "$EPOCHREALTIME" > $out/build-info',
    "  '' ];",
    "}",
  ].join("\n");

interface NixBuild {
  readonly output: string;
  readonly path: string;
  readonly seed: string;
  readonly builderUid: number;
  readonly start: number;
  readonly end: number;
}

const buildAs = async (target: SealantTarget, who: string, seed: string): Promise<NixBuild> => {
  const built = await exec(
    target,
    [
      'echo "NIX_REMOTE=${NIX_REMOTE:-unset}"',
      `cat > "$HOME/pl-${seed}.nix" <<'PL_NIX'`,
      uncachedDerivation(who, seed),
      "PL_NIX",
      `out=$(nix-build --no-out-link "$HOME/pl-${seed}.nix")`,
      'echo "build-exit=$?"',
      'echo "out=$out"',
      'cat "$out/build-info"',
      'stat -c "owner=%u:%g" "$out"',
      `echo "builder=$(getent passwd "$(sed -n 's/.*builder-uid=\\([0-9]*\\).*/\\1/p' "$out/build-info")" | cut -d: -f1,3)"`,
    ].join("\n"),
    who,
  );
  const info = /^seed=(\S+) builder-uid=(\d+) start=([\d.]+) end=([\d.]+)$/m.exec(built.output);
  return {
    output: built.output,
    path: /^out=(\S*)$/m.exec(built.output)?.[1] ?? "",
    seed: info?.[1] ?? "",
    builderUid: Number(info?.[2]),
    start: Number(info?.[3]),
    end: Number(info?.[4]),
  };
};

const buildConcurrently = async (
  target: SealantTarget,
  phase: string,
): Promise<Record<string, NixBuild>> => {
  const builds = await Promise.all(
    PEOPLE.map((person) =>
      buildAs(target, person.name, `${SUFFIX}${phase.replace(/\W/g, "")}${person.uid}`),
    ),
  );
  const [alice, bob] = builds;
  for (const [index, person] of PEOPLE.entries()) {
    evidence(`${phase} nix build as ${person.name}`, builds[index]!.output.trim());
  }
  const overlap = alice!.start < bob!.end && bob!.start < alice!.end;
  evidence(`${phase} nix builds overlap`, {
    overlap,
    builderUids: builds.map((build) => build.builderUid),
  });
  for (const build of builds) {
    expect([build.builderUid, build.start, build.end].every(Number.isFinite), build.output).toBe(
      true,
    );
  }
  expect(overlap).toBe(true);
  expect(alice!.builderUid).not.toBe(bob!.builderUid);
  for (const [index, person] of PEOPLE.entries()) {
    const build = builds[index]!;
    expect(build.output).toContain("NIX_REMOTE=daemon");
    expect(build.output).toMatch(/will be built/);
    expect(build.output).toContain("build-exit=0");
    expect(build.path).toMatch(new RegExp(`^/nix/store/[a-z0-9]{32}-pl-${person.name}-`));
    expect(build.output).toContain("owner=0:0");
    expect(build.output).toMatch(/^builder=nixbld\d+:\d+$/m);
  }
  expect(alice!.path).not.toBe(bob!.path);
  expect(alice!.seed).not.toBe(bob!.seed);
  return Object.fromEntries(PEOPLE.map((person, index) => [person.name, builds[index]!]));
};

/** The image installed the default profile from flake references, which `profile list` reads. */
const defaultProfile = async (target: SealantTarget): Promise<string> =>
  (
    await exec(
      target,
      `readlink ${NIX_PROFILE}; ${NIX} --extra-experimental-features flakes profile list --profile ${NIX_PROFILE}`,
    )
  ).output;

const NIX_DAEMON_PIDS =
  'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = nix-daemon ] && echo "${p#/proc/}"; done';

const workspaceContainer = (pod: V1Pod | undefined) =>
  pod?.spec?.containers.find((container) => container.name !== "docker");

const savePodYaml = async (podName: string, label: string): Promise<void> => {
  if (EVIDENCE_DIR === undefined) return;
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(
    join(EVIDENCE_DIR, `${label}-${podName}.yaml`),
    await kubectl("get", "pod", podName, "-o", "yaml"),
  );
};

const CHANNEL_FIXTURE = fileURLToPath(
  new URL("../runtime/capture-channel.fixture.ts", import.meta.url),
);
const REPO_ROOT = resolvePath(CHANNEL_FIXTURE, "../../../../..");
const CHANNEL_IMAGE = "node:24-alpine";
/** How often the channel container prints its head and errors to its log. */
const CHANNEL_SAMPLE_MS = 250;

interface ChannelContainer {
  readonly name: string;
  readonly endpoint: string;
  readonly logs: () => Promise<string>;
}

/** Node strips types, so the container imports the `.ts` fixture straight from this checkout. */
const startChannelContainer = async (): Promise<ChannelContainer> => {
  const name = `person-layout-channel-${SUFFIX}`;
  const script = [
    `import { networkInterfaces } from "node:os";`,
    `import { startCaptureChannel } from ${JSON.stringify(CHANNEL_FIXTURE)};`,
    `const ip = Object.values(networkInterfaces()).flat().find((a) => a?.family === "IPv4" && !a.internal)?.address;`,
    `const channel = await startCaptureChannel({ token: ${JSON.stringify(CAPTURE_TOKEN)}, worktreeId: ${JSON.stringify(WORKTREE_ID)}, advertiseHost: ip });`,
    "console.log(`endpoint=${channel.endpoint}`);",
    "let head;",
    "setInterval(() => {",
    "  if (channel.state.head?.n !== head) { head = channel.state.head?.n; console.log(`head=${head}`); }",
    "  for (const e of channel.state.errors.splice(0)) console.log(`error=${e instanceof Error ? e.message : String(e)}`);",
    `}, ${String(CHANNEL_SAMPLE_MS)});`,
  ].join("\n");
  await execFileAsync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--network",
    "kind",
    "-v",
    `${REPO_ROOT}:${REPO_ROOT}:ro`,
    CHANNEL_IMAGE,
    "node",
    "--input-type=module",
    "-e",
    script,
  ]);
  const logs = async (): Promise<string> => {
    const { stdout, stderr } = await execFileAsync("docker", ["logs", name]);
    return stdout + stderr;
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    const endpoint = /^endpoint=(\S+)$/m.exec(await logs())?.[1];
    if (endpoint !== undefined) return { name, endpoint, logs };
    if (Date.now() > deadline)
      throw new Error(`the capture channel never started: ${await logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

describe.skipIf(!E2E_ENABLED)("Kubernetes per-person layout (runc)", () => {
  let api: KubernetesApi;
  let adapter: KubernetesRuntimeAdapter;
  let channel: ChannelContainer | undefined;
  let registryForward: RegistryForward | undefined;
  let publishedImage: PublishedImage;
  let perPerson: WorkspaceBlueprint;
  let perPersonDocker: WorkspaceBlueprint;
  let userNamespaces: UserNamespaceSupport = { supported: false, reason: "not probed" };
  const running = new Set<string>();

  const requireUserNamespaces = (ctx: { skip: (note?: string) => void }): void => {
    if (!userNamespaces.supported) {
      ctx.skip(`cluster cannot run user-namespaced Pods: ${userNamespaces.reason}`);
    }
  };

  const launch = async (
    blueprint: WorkspaceBlueprint,
    runId: string,
  ): Promise<{ podName: string; target: SealantTarget }> => {
    const input: RuntimeAdapterLaunchInput = {
      blueprint,
      publishedImage,
      runId,
      workspaceId: `ws-${runId}`,
      secretEnv: { SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN },
    };
    const result = await adapter.launch(input);
    expect(result.status).toBe("ready");
    running.add(result.resourceId);
    return {
      podName: result.resourceId,
      target: { kind: "websocket", url: result.endpoint ?? "", tls: clientTls },
    };
  };

  const stopAndWait = async (podName: string, runId: string): Promise<void> => {
    expect((await adapter.stop({ resourceId: podName })).outcome).toBe("stopped");
    running.delete(podName);
    const deadline = Date.now() + 180_000;
    for (;;) {
      const remaining = (
        await kubectl("get", "pods", "-l", `sealant.sh/run-id=${runId}`, "-o", "name")
      ).trim();
      if (remaining === "") return;
      if (Date.now() > deadline) expect(remaining).toBe("");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };

  /** The container prints errors only on its sampler tick, so this reads after one has passed. */
  const expectNoChannelErrors = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 2 * CHANNEL_SAMPLE_MS));
    expect((await channel!.logs()).match(/^error=.*$/gm) ?? []).toEqual([]);
  };

  const flushAndStop = async (
    workspace: { podName: string; target: SealantTarget },
    runId: string,
    phase: string,
  ): Promise<void> => {
    const flushed = await withDaemon(workspace.target, (session) => session.captureFlush());
    evidence(`${phase} flush`, {
      fenced: flushed.fenced,
      pending: flushed.pending,
      headN: flushed.headN,
    });
    expect(flushed.fenced).toBe(false);
    expect(flushed.pending).toBe(0);
    expect(flushed.headN).toBeDefined();
    const registered = new RegExp(`^head=${String(flushed.headN)}$`, "m");
    const deadline = Date.now() + 10_000;
    let channelLog = await channel!.logs();
    while (!registered.test(channelLog) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CHANNEL_SAMPLE_MS));
      channelLog = await channel!.logs();
    }
    evidence(`${phase} channel heads`, channelLog.match(/^head=\S+$/gm) ?? []);
    expect(channelLog).toMatch(registered);
    await stopAndWait(workspace.podName, runId);
  };

  const expectPerPersonPod = async (
    podName: string,
    phase: string,
    userNamespaced: boolean,
  ): Promise<void> => {
    const pod = await api.getPod(podName);
    const security = workspaceContainer(pod)?.securityContext;
    evidence(`${phase} Pod spec`, {
      hostUsers: pod?.spec?.hostUsers,
      allowPrivilegeEscalation: security?.allowPrivilegeEscalation,
      capabilities: security?.capabilities,
    });
    expect(pod?.spec?.hostUsers).toBe(userNamespaced ? false : undefined);
    expect(security?.allowPrivilegeEscalation).toBe(true);
    expect(security?.capabilities?.add).toContain("FSETID");
  };

  const expectOwnerMapDaemon = async (target: SealantTarget, phase: string): Promise<void> => {
    const daemon = await withDaemon(target, (session) =>
      Effect.all({ capabilities: session.capabilities, status: session.captureStatus() }),
    );
    evidence(`${phase} daemon`, {
      noNewPrivileges: daemon.capabilities.noNewPrivileges,
      ownerMap: daemon.status.ownerMap,
    });
    expect(daemon.capabilities.noNewPrivileges).toBe(false);
    expect(daemon.status.ownerMap).toBe(true);
  };

  const expectRestoredFiles = async (
    target: SealantTarget,
    phase: string,
    contents: string,
  ): Promise<void> => {
    const files = await exec(
      target,
      `stat -c "%n %u:%g:%a" ${REPO} a.txt b.txt; getfacl -p ${REPO} a.txt b.txt; cat a.txt; echo ---; cat b.txt`,
    );
    evidence(`${phase} restored files`, files.output.trim());
    expect(files.output).toContain(`${REPO} ${String(ALICE.uid)}:${String(MEND_GID)}:2775`);
    expect(files.output).toMatch(new RegExp(`^a\\.txt \\d+:${String(MEND_GID)}:66\\d$`, "m"));
    expect(files.output).toMatch(new RegExp(`^b\\.txt \\d+:${String(MEND_GID)}:66\\d$`, "m"));
    expect(files.output).toContain(contents);
  };

  beforeAll(async () => {
    const kubeconfigPath = process.env["KUBECONFIG"];
    userNamespaces = await probeUserNamespaces();
    evidence("user namespaces", userNamespaces);
    if (!userNamespaces.supported) {
      console.warn(
        `[person-layout e2e] this cluster cannot run user-namespaced Pods (${userNamespaces.reason}); step 6, the per-person Pod with the Docker service, will skip.`,
      );
    }
    channel = await startChannelContainer();
    // From the workspace node: a refused or filtered port here would otherwise surface as a
    // launch that never becomes ready.
    const node = (
      await kubectl(
        "get",
        "nodes",
        "-l",
        "sealant.sh/e2e-role=workspace",
        "-o",
        "jsonpath={.items[0].metadata.name}",
      )
    ).trim();
    const { stdout: reach } = await execFileAsync("docker", [
      "exec",
      node,
      "curl",
      "-sS",
      "-m",
      "10",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-X",
      "POST",
      `${channel.endpoint}/plan.get`,
    ]);
    evidence(`capture channel ${channel.endpoint} from node ${node}`, `HTTP ${reach}`);
    expect(reach).toBe("401");

    perPerson = blueprintFor({ endpoint: channel.endpoint, ownerMap: OWNER_MAP, docker: false });
    perPersonDocker = blueprintFor({
      endpoint: channel.endpoint,
      ownerMap: OWNER_MAP,
      docker: true,
    });
    registryForward = await startRegistryForward();
    api = createLiveKubernetesApi({ namespace: NAMESPACE, kubeconfigPath });
    adapter = new KubernetesRuntimeAdapter({
      id: "k8s",
      config: kubernetesRuntimeConfigSchema.parse({
        namespace: NAMESPACE,
        volumeMappings: [{ logicalRoot: "/var/lib/mend/store", claimName: "mend-store" }],
        resources: {
          requests: { cpu: "250m", memory: "512Mi" },
          limits: { cpu: "2", memory: "2Gi" },
        },
        certManagerIssuer: { name: "sealant-internal" },
        nodeSelector: { "sealant.sh/e2e-role": "workspace" },
        topologySpread: false,
        readinessTimeoutMs: 10 * 60_000,
        docker: { enabled: true, graphSize: "4Gi" },
        ...(kubeconfigPath === undefined ? {} : { kubeconfigPath }),
      }),
      api,
      clientTls,
      controlChannel: forwardedControlChannel,
    });
  }, 5 * 60_000);

  afterAll(async () => {
    await Promise.all(
      Array.from(running, (podName) =>
        adapter.stop({ resourceId: podName }).catch(() => undefined),
      ),
    );
    registryForward?.child.kill("SIGTERM");
    if (channel !== undefined) {
      evidence("capture channel log", (await channel.logs().catch(() => "")).trim());
      await execFileAsync("docker", ["rm", "-f", channel.name]).catch(() => undefined);
    }
  });

  it(
    "1. builds the image in the cluster and reads back a probe that supports the layout",
    async () => {
      const built = await buildWorkspaceImage({
        blueprint: perPersonDocker,
        registryPort: registryForward!.port,
        tag: `${FAMILY}-person-layout`,
        kubeconfigPath: process.env["KUBECONFIG"],
      });
      publishedImage = built.publishedImage;
      evidence("step 1 image", publishedImage.digestReference);
      evidence("step 1 build notes", built.build.metadata?.notes ?? []);
      const recorded = built.build.metadata?.imageProbe;
      expect(recorded).toBeDefined();
      const probe = parseWorkspaceImageProbe(recorded);
      evidence("step 1 imageProbe", probe);
      evidence("step 1 imageProbe.noNewPrivileges", String(probe.noNewPrivileges));
      const support = imagePersonLayoutSupport(probe);
      evidence("step 1 imagePersonLayoutSupport", support);
      expect(support).toEqual({ status: "supported", missing: [], unknown: [] });
    },
    35 * 60_000,
  );

  let first: { podName: string; target: SealantTarget } | undefined;
  const firstRun = `run-e2e-person-a-${SUFFIX}`;
  let second: { podName: string; target: SealantTarget } | undefined;
  const restoredRun = `run-e2e-person-b-${SUFFIX}`;

  it(
    "2. launches one capture workspace for two people without Docker: escalation, FSETID, the node's user namespace",
    async () => {
      first = await launch(perPerson, firstRun);
      await savePodYaml(first.podName, "step2-per-person");
      await expectPerPersonPod(first.podName, "step 2", false);
      await expectOwnerMapDaemon(first.target, "step 2");
    },
    15 * 60_000,
  );

  it("3. makes the two people as Mend's prepare does, beside the daemon's worktree ACL", async () => {
    await preparePeople(first!.target, "step 3");
    const worktree = await exec(first!.target, `stat -c "%u:%g:%a" ${REPO}; getfacl -p ${REPO}`);
    evidence("step 3 worktree root", worktree.output.trim());
    expect(worktree.output).toContain(`${String(ALICE.uid)}:${String(MEND_GID)}:2775`);
    expect(worktree.output).toMatch(/^default:group::rwx/m);
  }, 120_000);

  it("4. as each person: own home, NoNewPrivs 0, sudo, shared edits; root keeps setgid", async () => {
    const target = first!.target;
    await checkPeople(target, "step 4");
    const made = await exec(
      target,
      `echo from-a > a.txt && stat -c "%u:%g:%a" a.txt && getfacl -p a.txt`,
      ALICE.name,
    );
    evidence(`step 4 ${ALICE.name} makes a.txt`, made.output.trim());
    expect(made.exitCode).toBe(0);
    expect(made.output).toContain(`${String(ALICE.uid)}:${String(MEND_GID)}:`);
    expect(made.output).toMatch(/^group::rw/m);
    const byBob = await exec(target, "echo b-edit >> a.txt && echo from-b > b.txt", BOB.name);
    evidence(
      `step 4 ${BOB.name} edits a.txt, makes b.txt`,
      `exit ${String(byBob.exitCode)} ${byBob.output.trim()}`,
    );
    expect(byBob.exitCode).toBe(0);
    const byAlice = await exec(target, "echo a-edit >> b.txt", ALICE.name);
    evidence(
      `step 4 ${ALICE.name} edits b.txt`,
      `exit ${String(byAlice.exitCode)} ${byAlice.output.trim()}`,
    );
    expect(byAlice.exitCode).toBe(0);
    const contents = await exec(target, "cat a.txt; echo ---; cat b.txt");
    expect(contents.output).toBe("from-a\nb-edit\n---\nfrom-b\na-edit\n");
  }, 180_000);

  it.runIf(FAMILY === "nix")(
    "4n. nix: the daemon is PID 1's child; both people build at once and keep their own profiles",
    async () => {
      const target = first!.target;
      const tree = await exec(
        target,
        [
          "echo \"pid1=$(tr '\\0' ' ' < /proc/1/cmdline)\"",
          `for pid in $(${NIX_DAEMON_PIDS}); do`,
          `  echo "nix-daemon pid=$pid $(grep -E '^(PPid|Uid):' /proc/$pid/status | tr -s '\\t\\n' '  ')"`,
          "done",
        ].join("\n"),
      );
      evidence("step 4n process tree", tree.output.trim());
      expect(tree.output).toMatch(/^pid1=\/usr\/local\/bin\/sealantd boot/m);
      expect(tree.output).toMatch(/^nix-daemon pid=\d+ PPid: 1 Uid: 0 /m);

      const rootBefore = await defaultProfile(target);
      const builds = await buildConcurrently(target, "step 4n");
      const profiles: Record<string, string> = {};
      for (const person of PEOPLE) {
        const installed = await exec(
          target,
          [
            `${NIX} profile add ${builds[person.name]!.path}`,
            'echo "add-exit=$?"',
            'echo "link=$(readlink "$HOME/.nix-profile")"',
            `"$HOME/.nix-profile/bin/pl-${person.name}"`,
            `${NIX} profile list`,
          ].join("\n"),
          person.name,
        );
        evidence(`step 4n nix profile as ${person.name}`, installed.output.trim());
        expect(installed.output).toContain("add-exit=0");
        expect(installed.output).toContain(`link=/home/${person.name}/`);
        expect(installed.output).toContain(builds[person.name]!.seed);
        profiles[person.name] = installed.output;
      }
      const aliceAfterBob = await exec(target, `${NIX} profile list`, ALICE.name);
      const rootAfter = await defaultProfile(target);
      evidence(
        `step 4n ${ALICE.name}'s profile after ${BOB.name}'s add`,
        aliceAfterBob.output.trim(),
      );
      evidence("step 4n default profile", {
        before: rootBefore.trim(),
        after: rootAfter.trim(),
      });
      for (const [own, other] of [
        [ALICE, BOB],
        [BOB, ALICE],
      ] as const) {
        expect(profiles[own.name]).toContain(builds[own.name]!.path);
        expect(profiles[own.name]).not.toContain(builds[other.name]!.path);
      }
      expect(aliceAfterBob.output).toContain(builds[ALICE.name]!.path);
      expect(aliceAfterBob.output).not.toContain(builds[BOB.name]!.path);
      expect(rootBefore).toMatch(/^Store paths: +\/nix\/store\//m);
      expect(rootAfter).toBe(rootBefore);
      for (const build of Object.values(builds)) expect(rootAfter).not.toContain(build.path);
    },
    10 * 60_000,
  );

  it(
    "5. captures, stops, restores into a fresh Pod with the same map, and repeats 4",
    async () => {
      await flushAndStop(first!, firstRun, "step 5");

      const restored = await launch(perPerson, restoredRun);
      second = restored;
      await savePodYaml(restored.podName, "step5-restored");
      await expectPerPersonPod(restored.podName, "step 5", false);
      await preparePeople(restored.target, "step 5");
      await expectRestoredFiles(restored.target, "step 5", "from-a\nb-edit\n---\nfrom-b\na-edit\n");

      await checkPeople(restored.target, "step 5");
      const byBob = await exec(restored.target, "echo b-after-restore >> a.txt", BOB.name);
      const byAlice = await exec(restored.target, "echo a-after-restore >> b.txt", ALICE.name);
      evidence("step 5 edits after restore", {
        [BOB.name]: { exit: byBob.exitCode, output: byBob.output.trim() },
        [ALICE.name]: { exit: byAlice.exitCode, output: byAlice.output.trim() },
      });
      expect(byBob.exitCode).toBe(0);
      expect(byAlice.exitCode).toBe(0);
      await expectNoChannelErrors();
    },
    20 * 60_000,
  );

  it.runIf(FAMILY === "nix")(
    "5n. nix after restore: both people build at once; with the daemon stopped, a person's nix fails",
    async () => {
      const target = second!.target;
      await buildConcurrently(target, "step 5n");

      const stopped = await exec(
        target,
        [
          `for pid in $(${NIX_DAEMON_PIDS}); do kill "$pid"; done`,
          `for _ in $(seq 50); do [ -z "$(${NIX_DAEMON_PIDS})" ] && break; sleep 0.2; done`,
          `echo "left=$(${NIX_DAEMON_PIDS} | wc -l)"`,
        ].join("\n"),
      );
      evidence("step 5n nix-daemon stopped", stopped.output.trim());
      expect(stopped.output).toContain("left=0");
      const refused = await exec(
        target,
        [
          'echo "NIX_REMOTE=${NIX_REMOTE:-unset}"',
          `${NIX} store info`,
          'echo "store-info-exit=$?"',
          `cat > "$HOME/pl-refused.nix" <<'PL_NIX'`,
          uncachedDerivation(ALICE.name, `${SUFFIX}refused`),
          "PL_NIX",
          'nix-build --no-out-link "$HOME/pl-refused.nix"',
          'echo "build-exit=$?"',
          'ls -d "$HOME/.local/share/nix/root" 2>/dev/null || echo "private-store=none"',
        ].join("\n"),
        ALICE.name,
      );
      evidence(`step 5n nix as ${ALICE.name} with the daemon stopped`, refused.output.trim());
      expect(refused.output).toContain("NIX_REMOTE=daemon");
      expect(refused.output).toMatch(/^store-info-exit=[1-9]\d*$/m);
      expect(refused.output).toMatch(/^build-exit=[1-9]\d*$/m);
      expect(refused.output).toMatch(/daemon-socket\/socket/);
      expect(refused.output).toContain("private-store=none");

      await exec(
        target,
        `rm -f /nix/var/nix/daemon-socket/socket; setsid -f nix-daemon </dev/null >/dev/null 2>&1; for _ in $(seq 50); do NIX_REMOTE=daemon ${NIX} store info >/dev/null 2>&1 && break; sleep 0.2; done`,
      );
      const back = await exec(target, `${NIX} store info; echo "store-info-exit=$?"`, ALICE.name);
      evidence(`step 5n nix as ${ALICE.name} after the daemon restarts`, back.output.trim());
      expect(back.output).toContain("store-info-exit=0");
    },
    10 * 60_000,
  );

  it("5c. flushes and stops the restored Pod", async () => {
    await flushAndStop(second!, restoredRun, "step 5 restored");
  }, 240_000);

  let docker: { podName: string; target: SealantTarget } | undefined;
  const dockerRun = `run-e2e-person-docker-${SUFFIX}`;

  it(
    "6. restores the work into a per-person Pod with Docker: user namespace, people, shared edits",
    async (ctx) => {
      requireUserNamespaces(ctx);
      docker = await launch(perPersonDocker, dockerRun);
      await savePodYaml(docker.podName, "step6-per-person-docker");
      await expectPerPersonPod(docker.podName, "step 6", true);
      await expectOwnerMapDaemon(docker.target, "step 6");
      await preparePeople(docker.target, "step 6");
      await expectRestoredFiles(
        docker.target,
        "step 6",
        "from-a\nb-edit\nb-after-restore\n---\nfrom-b\na-edit\na-after-restore\n",
      );
      await checkPeople(docker.target, "step 6");
      const byBob = await exec(docker.target, "echo b-in-docker-pod >> a.txt", BOB.name);
      evidence("step 6 edit", { exit: byBob.exitCode, output: byBob.output.trim() });
      expect(byBob.exitCode).toBe(0);
    },
    20 * 60_000,
  );

  it("6a. Docker as root and as each person, through the sidecar", async (ctx) => {
    requireUserNamespaces(ctx);
    await checkDocker(docker!.target, "step 6a");
  }, 300_000);

  it("6b. Docker as each person again after the sidecar's daemon dies and restarts", async (ctx) => {
    requireUserNamespaces(ctx);
    const sidecar = async () =>
      (await api.getPod(docker!.podName))?.status?.initContainerStatuses?.find(
        (status) => status.name === "docker",
      );
    const before = (await sidecar())?.restartCount ?? 0;
    await kubectl("exec", docker!.podName, "-c", "docker", "--", "pkill", "-x", "dockerd");
    const deadline = Date.now() + 180_000;
    let after = await sidecar();
    while (!((after?.restartCount ?? 0) > before && after?.started === true)) {
      if (Date.now() > deadline)
        throw new Error(`sidecar did not restart: ${JSON.stringify(after)}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      after = await sidecar();
    }
    evidence("step 6b sidecar restarts", { before, after: after.restartCount });
    await checkDocker(docker!.target, "step 6b");
    await expectNoChannelErrors();
    await stopAndWait(docker!.podName, dockerRun);
  }, 600_000);

  it(
    "7a. a map that names nobody keeps no-new-privileges",
    async () => {
      const runId = `run-e2e-person-none-${SUFFIX}`;
      const nobody = await launch(
        blueprintFor({
          endpoint: channel!.endpoint,
          ownerMap: { gid: MEND_GID, worktreeUid: ALICE.uid, people: [] },
          docker: false,
        }),
        runId,
      );
      await savePodYaml(nobody.podName, "step7a-no-people");
      const security = workspaceContainer(await api.getPod(nobody.podName))?.securityContext;
      const status = await exec(nobody.target, "grep NoNewPrivs /proc/self/status");
      const capabilities = await withDaemon(nobody.target, (session) => session.capabilities);
      evidence("step 7a", {
        allowPrivilegeEscalation: security?.allowPrivilegeEscalation,
        capabilities: security?.capabilities,
        daemonNoNewPrivileges: capabilities.noNewPrivileges,
        status: status.output.trim(),
      });
      expect(security?.allowPrivilegeEscalation).toBe(false);
      expect(security?.capabilities?.add).not.toContain("FSETID");
      expect(capabilities.noNewPrivileges).toBe(true);
      expect(status.output).toMatch(/NoNewPrivs:\s*1/);
      await stopAndWait(nobody.podName, runId);
    },
    15 * 60_000,
  );

  it("7b. an owner map under gVisor is refused at the adapter", async () => {
    const gvisor = (ownerMap: boolean) =>
      adapter.supports({
        blueprint: blueprintFor({
          endpoint: channel!.endpoint,
          ...(ownerMap ? { ownerMap: OWNER_MAP } : {}),
          docker: true,
          ociRuntime: "runsc",
        }),
      });
    const refused = gvisor(true);
    const withoutMap = gvisor(false);
    evidence("step 7b", { withMap: refused, withoutMap });
    expect(refused.supported).toBe(false);
    expect(refused.supported ? "" : refused.message).toContain("runs under runc on Kubernetes");
    expect(withoutMap.supported ? "" : withoutMap.message).not.toContain("source.ownerMap");
    await expect(
      adapter.launch({
        blueprint: blueprintFor({
          endpoint: channel!.endpoint,
          ownerMap: OWNER_MAP,
          docker: true,
          ociRuntime: "runsc",
        }),
        publishedImage,
        runId: `run-e2e-person-gvisor-${SUFFIX}`,
        workspaceId: "ws-person-gvisor",
      }),
    ).rejects.toThrow(/runs under runc on Kubernetes/);
  });
});
