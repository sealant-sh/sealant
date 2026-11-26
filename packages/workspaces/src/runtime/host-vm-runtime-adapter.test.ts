import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cases, publishedImage } from "./docker-runtime-adapter.golden-fixture.js";
import {
  hostVmEgressFlags,
  hostVmMemory,
  hostVmRunnerWidens,
  HostVmRuntimeAdapter,
  underRecoveredRoot,
} from "./host-vm-runtime-adapter.js";
import {
  createHostVmHarness,
  EXECUTOR_CA_PEM,
  fakeEgressLaunch,
  HOST_VM_DIGEST,
  HOST_VM_KEY,
  HOST_VM_REFERENCE,
  type HostVmHarness,
} from "./host-vm.fixture.js";
import { LaunchRetainedError } from "./launch-retention.js";
import type { RuntimeAdapterLaunchInput } from "./runtime-adapter.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** A golden launch on a host VM: the publication names a real digest, as every build does. */
const onHostVm = (input: RuntimeAdapterLaunchInput): RuntimeAdapterLaunchInput => ({
  ...input,
  blueprint: {
    ...input.blueprint,
    target: { ...input.blueprint.target, runtime: { family: "host-vm", mode: "require" } },
  },
  publication: {
    ...input.publication,
    image: { ...publishedImage, digest: HOST_VM_DIGEST, digestReference: HOST_VM_REFERENCE },
  },
  // The worker hands every host-vm launch its proxy launch (`egressProxyLaunch`).
  egressProxy: fakeEgressLaunch(),
});

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** The values that follow each occurrence of `flag` in an argv. */
const valuesOf = (args: readonly string[], flag: string): string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));

const runnerRun = (harness: HostVmHarness): string[] =>
  harness.calls.find((args) => args[0] === "run" && args.includes("--name")) ?? [];

let harness: HostVmHarness | undefined;
const make = async (...args: Parameters<typeof createHostVmHarness>) => {
  harness = await createHostVmHarness(...args);
  return harness;
};
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe("HostVmRuntimeAdapter.launch", () => {
  it("runs the runner in exactly the jail sealant-vm-runner expects", async () => {
    const h = await make();
    const result = await h.adapter.launch(onHostVm(cases.gitSource));
    const run = runnerRun(h);
    const name = "sealant-vm-run-golden-1";

    expect(result).toMatchObject({
      adapter: "host-vm",
      resourceId: name,
      reference: name,
      status: "ready",
      endpoint: `unix://${joinPath(h.controlDir, name, "control.sock")}`,
    });
    // Exactly four capabilities, after dropping all of them.
    expect(valuesOf(run, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(run, "--cap-add").toSorted()).toEqual([
      "NET_ADMIN",
      "SETGID",
      "SETPCAP",
      "SETUID",
    ]);
    expect(valuesOf(run, "--security-opt")).toEqual(["no-new-privileges:true"]);
    expect(valuesOf(run, "--device")).toEqual(["/dev/kvm:/dev/kvm", "/dev/net/tun:/dev/net/tun"]);
    expect(run).toContain("--read-only");
    expect(valuesOf(run, "--tmpfs")).toEqual([
      "/tmp:rw,nosuid,nodev,noexec,uid=65532,gid=65532",
      "/run/vm:rw,nosuid,nodev,noexec,uid=65532,gid=65532",
    ]);
    // Never privileged, never the Docker socket, never Mend's own network.
    expect(run.join(" ")).not.toMatch(/--privileged|docker\.sock|mend_default/);
    // Alone with its proxy on its isolated network: no gateway, no other way out.
    expect(valuesOf(run, "--network")).toEqual([`${name}-isolated`]);
    expect(h.networks.get(`${name}-isolated`)).toEqual(new Set([`${name}-proxy`]));
    // Only this executor's base disk, read-only; its own data and control directories.
    expect(valuesOf(run, "--mount")).toEqual([
      `type=bind,source=${joinPath(h.imagesDir, `${HOST_VM_KEY}.img`)},target=/var/lib/sealant/images/${HOST_VM_KEY}.img,readonly`,
      `type=bind,source=${joinPath(h.dataDir, name)},target=/var/lib/sealant/data`,
      `type=bind,source=${joinPath(h.controlDir, name)},target=/run/sealant`,
    ]);
    // The runner's own flags, after its image.
    const runnerArgs = run.slice(run.indexOf("ghcr.io/sealant-sh/vm-runner:test") + 1);
    expect(runnerArgs).toEqual([
      "--mode",
      "normal",
      "--image-digest",
      HOST_VM_KEY,
      "--vcpus",
      "2",
      "--memory-mib",
      String((8 * GiB) / MiB),
      "--shutdown-grace-secs",
      "20",
      "--proxy-ip",
      // The last usable address of the isolated /29 (`proxyAddressOf`).
      "10.250.1.6",
      "--egress",
      "standard",
    ]);
  });

  it("gives the container the guest's memory plus 512 MiB, and the guest dockerd's share", async () => {
    const h = await make({
      memory: {
        workspace: { kind: "bytes", bytes: 4 * GiB },
        service: { kind: "bytes", bytes: 2 * GiB },
      },
    });
    await h.adapter.launch(onHostVm(cases.dind));
    const run = runnerRun(h);
    expect(valuesOf(run, "--memory-mib")).toEqual(["6144"]);
    expect(valuesOf(run, "--memory")).toEqual([String(6 * GiB + 512 * MiB)]);
    expect(valuesOf(run, "--memory-swap")).toEqual([String(6 * GiB + 512 * MiB)]);
    expect(hostVmMemory({ workspace: 4 * GiB, service: 2 * GiB }, false)).toEqual({
      guestMib: 4096,
      containerBytes: 4 * GiB + 512 * MiB,
    });
  });

  it("stops the runner with a timeout longer than the guest's shutdown grace", async () => {
    const h = await make();
    await h.adapter.launch(onHostVm(cases.gitSource));
    expect(valuesOf(runnerRun(h), "--stop-timeout")).toEqual(["35"]);
    await h.adapter.stop({ resourceId: "sealant-vm-run-golden-1", phase: "end" });
    expect(h.calls.find((args) => args[0] === "stop")).toEqual([
      "stop",
      "-t",
      "35",
      "sealant-vm-run-golden-1",
    ]);
    expect(
      () =>
        new HostVmRuntimeAdapter({
          storage: h.storage,
          diskRecords: { record: async () => undefined, load: async () => undefined },
          commandRunner: async () => ({ stdout: "", stderr: "" }),
          runnerImage: "vm-runner",
          shutdownGraceSeconds: 20,
          stopTimeoutSeconds: 20,
        }),
    ).toThrow(/must be longer than the runner's shutdown grace/);
  });

  it("records the data disk and base image on the run's row before the runner exists", async () => {
    const h = await make();
    await h.adapter.launch(onHostVm(cases.gitSource));
    // The disk on record, then the proxy loaded with its first policy, then the runner.
    expect(h.events).toEqual([
      "record:run-golden-1",
      "policy:sealant-vm-run-golden-1",
      "run:sealant-vm-run-golden-1",
    ]);
    expect(h.records.get("run-golden-1")).toEqual({
      dataDiskPath: joinPath(h.dataDir, "sealant-vm-run-golden-1", "data.img"),
      baseImageDigest: HOST_VM_DIGEST,
      // What the runner's own firewall lets out, for a policy applied while it runs.
      runnerEgress: { mode: "standard", allowTcpPorts: [] },
    });
  });

  it("stages boot-env.json in sealant-vm-runner's wire format and removes it once ready", async () => {
    const h = await make();
    const dotfiles = joinPath(h.root, "dotfiles");
    await mkdir(dotfiles);
    await writeFile(joinPath(dotfiles, "manifest.json"), "{}");
    await h.adapter.launch({ ...onHostVm(cases.capture), dotfilesArchiveDir: dotfiles });
    const name = "sealant-vm-run-golden-4";
    const staged = h.stagedAtRun[0];
    expect(staged?.mode).toBe("normal");
    // protocol.rs StagedLaunch: camelCase, the mode it is for, the secrets beside the boot env.
    expect(staged?.launch).toMatchObject({
      mode: "normal",
      secretEnv: { MEND_SESSION_TOKEN: "mst_secret", SEALANT_CAPTURE_TOKEN: "mst_secret" },
      dockerd: false,
      dotfilesArchive: { files: { "manifest.json": Buffer.from("{}").toString("base64") } },
    });
    expect(Object.keys(staged?.launch ?? {}).toSorted()).toEqual(
      ["bootEnv", "dockerd", "dotfilesArchive", "mode", "secretEnv"].toSorted(),
    );
    // The image config the guest applies, staged under the runner's --image-digest.
    const config = JSON.parse(
      await readFile(joinPath(h.controlDir, name, `${HOST_VM_KEY}.config.json`), "utf8"),
    );
    expect(config).toEqual({
      Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"],
      WorkingDir: "/workspace/repo",
      Entrypoint: ["/usr/local/bin/sealantd", "boot"],
      Labels: { "sh.sealant.plan-hash": "abc" },
    });
    // The secrets do not outlive the boot that read them.
    expect(await exists(joinPath(h.controlDir, name, "boot-env.json"))).toBe(false);
  });

  it("stages the daemon's telemetry for the runner, and leaves the launch's span out of recovery", async () => {
    const h = await make();
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const sentryDsn = "https://k@sentry.example.com/10";
    await h.adapter.launch({
      ...onHostVm(cases.gitSource),
      telemetry: { traceparent, sentryDsn, environment: "check" },
    });
    const staged = h.stagedAtRun[0]?.launch;
    expect(staged).toMatchObject({ telemetry: { traceparent, sentryDsn, environment: "check" } });
    // The runner hands the guest what it needs; the boot env itself names no telemetry.
    expect(JSON.stringify(Reflect.get(staged ?? {}, "bootEnv"))).not.toContain(traceparent);
    const template = JSON.parse(
      await readFile(
        joinPath(h.controlDir, "sealant-vm-run-golden-1", "recovery-env.json"),
        "utf8",
      ),
    );
    expect(template.telemetry).toEqual({ sentryDsn, environment: "check" });
  });

  it("keeps clone auth, platform and credential env out of the recovery template", async () => {
    const h = await make();
    await h.adapter.launch(onHostVm(cases.gitSource));
    const template = JSON.parse(
      await readFile(
        joinPath(h.controlDir, "sealant-vm-run-golden-1", "recovery-env.json"),
        "utf8",
      ),
    );
    expect(template).toMatchObject({ mode: "recover", secretEnv: {}, dockerd: false });
    const text = JSON.stringify(template);
    for (const secret of ["ghs_secret", "dot_secret", "gh_secret", "cc_secret"]) {
      expect(text).not.toContain(secret);
    }
    expect(template.bootEnv.SEALANT_WORKSPACE_REPO_URL).toBe("https://github.com/example/repo.git");
  });

  it("refuses a launch below the data filesystem's headroom floor, before anything is made", async () => {
    const h = await make();
    h.freeBytes = 9 * GiB;
    await expect(h.adapter.launch(onHostVm(cases.gitSource))).rejects.toThrow(
      /Only 9\.0 GiB is free .*needs at least 10\.0 GiB/,
    );
    expect(runnerRun(h)).toEqual([]);
    expect(h.pipes).toEqual([]);
    h.freeBytes = 2 * GiB;
    expect(await h.storage.headroom()).toEqual({
      freeBytes: 2 * GiB,
      admitsLaunch: false,
      low: true,
    });
  });

  it("keeps a capture launch's data disk when its earlier runner was pruned", async () => {
    const h = await make();
    const name = "sealant-vm-run-golden-4";
    await mkdir(joinPath(h.dataDir, name), { recursive: true });
    await writeFile(joinPath(h.dataDir, name, "data.img"), "work");
    await expect(h.adapter.launch(onHostVm(cases.capture))).rejects.toBeInstanceOf(
      LaunchRetainedError,
    );
    expect(await readFile(joinPath(h.dataDir, name, "data.img"), "utf8")).toBe("work");
    expect(runnerRun(h)).toEqual([]);
  });

  it("is unavailable without an egress proxy, since a normal boot needs one", async () => {
    const h = await make({ withoutProxy: true });
    expect(h.adapter.supports({ blueprint: onHostVm(cases.gitSource).blueprint })).toMatchObject({
      supported: false,
      reason: "adapter-unavailable",
    });
  });
});

describe("HostVmRuntimeAdapter recovery", () => {
  const retained = async (options: { readonly prune: boolean }) => {
    const h = await make();
    await h.adapter.launch(onHostVm(cases.capture));
    const name = "sealant-vm-run-golden-4";
    await h.adapter.stop({ resourceId: name, phase: "end" });
    if (options.prune) h.containers.delete(name);
    h.stagedAtRun.length = 0;
    h.proxy.started.length = 0;
    return { h, name };
  };

  it("recreates a recovery runner on the kept disks after its container was pruned", async () => {
    const { h, name } = await retained({ prune: true });
    expect(await h.adapter.inspect({ resourceId: name })).toMatchObject({
      state: "exited",
      platformEnded: false,
    });
    const outcome = await h.adapter.recover({
      resourceId: name,
      runId: "run-golden-4",
      secretEnv: { SEALANT_CAPTURE_TOKEN: "capture-only" },
    });
    expect(outcome).toEqual({ outcome: "restarted" });
    const run = h.calls.filter((args) => args[0] === "run" && args.includes("--name")).at(-1) ?? [];
    expect(valuesOf(run, "--network")).toEqual(["none"]);
    expect(run).not.toContain("--proxy-ip");
    expect(
      run.slice(
        run.indexOf("ghcr.io/sealant-sh/vm-runner:test") + 1,
        run.indexOf("ghcr.io/sealant-sh/vm-runner:test") + 5,
      ),
    ).toEqual(["--mode", "recover", "--image-digest", HOST_VM_KEY]);
    expect(valuesOf(run, "--mount")[0]).toContain(`${HOST_VM_KEY}.img,readonly`);
    // No proxy, and the token only in the recovery launch file, for the boot that reads it.
    expect(h.proxy.started).toEqual([]);
    expect(h.proxy.parked).toContain(name);
    expect(h.stagedAtRun[0]).toMatchObject({
      mode: "recover",
      launch: {
        mode: "recover",
        secretEnv: { SEALANT_CAPTURE_TOKEN: "capture-only" },
        dockerd: false,
      },
    });
    const after = await readFile(joinPath(h.controlDir, name, "recovery-env.json"), "utf8");
    expect(after).not.toContain("capture-only");
  });

  it("replaces a stopped normal runner, whose boot mode is fixed, with a recovery runner", async () => {
    const { h, name } = await retained({ prune: false });
    expect(await h.adapter.recover({ resourceId: name, runId: "run-golden-4" })).toEqual({
      outcome: "restarted",
    });
    expect(h.calls).toContainEqual(["rm", "-f", name]);
    expect(h.containers.get(name)?.args).toContain("recover");
  });

  it("answers nothing-to-save on the runner's 76, and fails on any other exit", async () => {
    const { h, name } = await retained({ prune: true });
    h.exitOnBoot = 76;
    expect(await h.adapter.recover({ resourceId: name, runId: "run-golden-4" })).toMatchObject({
      outcome: "nothing-to-save",
    });
    h.containers.delete(name);
    h.exitOnBoot = 75;
    await expect(h.adapter.recover({ resourceId: name, runId: "run-golden-4" })).rejects.toThrow(
      /exited with 75/,
    );
  });

  it("finds the base image from the disk's marker when no run is named", async () => {
    const { h, name } = await retained({ prune: true });
    h.records.clear();
    expect(await h.adapter.recover({ resourceId: name })).toEqual({ outcome: "restarted" });
  });

  it("reports missing only once both the container and the data disk are gone", async () => {
    const { h, name } = await retained({ prune: true });
    await h.adapter.stop({ resourceId: name, phase: "remove" });
    expect(await exists(joinPath(h.dataDir, name, "data.img"))).toBe(false);
    expect(h.proxy.removed).toContain(name);
    expect(await h.adapter.inspect({ resourceId: name })).toEqual({ state: "missing" });
    expect(await h.adapter.recover({ resourceId: name })).toEqual({ outcome: "missing" });
  });

  it("parks the proxy of an ended runner and leaves a running one alone", async () => {
    const h = await make();
    await h.adapter.launch(onHostVm(cases.capture));
    const name = "sealant-vm-run-golden-4";
    expect(await h.adapter.parkRetained({ resourceId: name })).toEqual({ stopped: [] });
    await h.adapter.stop({ resourceId: name, phase: "end" });
    expect(await h.adapter.parkRetained({ resourceId: name })).toEqual({
      stopped: [`${name}-proxy`],
    });
    // The disk stays for the recovery.
    expect(await exists(joinPath(h.dataDir, name, "data.img"))).toBe(true);
  });
});

describe("HostVmRuntimeAdapter · what a failed launch may remove (review R1)", () => {
  it("removes nothing when it cannot tell what the run already has", async () => {
    const h = await make();
    const name = "sealant-vm-run-golden-4";
    await mkdir(joinPath(h.dataDir, name), { recursive: true });
    await writeFile(joinPath(h.dataDir, name, "data.img"), "work");
    h.inspectFails = true;
    await expect(h.adapter.launch(onHostVm(cases.capture))).rejects.toThrow(/Docker daemon/);
    expect(await readFile(joinPath(h.dataDir, name, "data.img"), "utf8")).toBe("work");
    expect(h.calls.filter((args) => args[0] === "rm")).toEqual([]);
    expect(h.proxy.removed).toEqual([]);
  });

  it("removes what it made, and keeps a data disk it found, when its runner fails", async () => {
    const h = await make();
    const name = "sealant-vm-run-golden-1";
    // A git launch of a run whose earlier attempt left a disk: not this launch's to remove.
    await mkdir(joinPath(h.dataDir, name), { recursive: true });
    await writeFile(joinPath(h.dataDir, name, "data.img"), "earlier");
    h.exitOnBoot = 1;
    await expect(h.adapter.launch(onHostVm(cases.gitSource))).rejects.toThrow(/exited with 1/);
    expect(h.containers.has(name)).toBe(false);
    expect(h.proxy.removed).toEqual([name]);
    expect(await readFile(joinPath(h.dataDir, name, "data.img"), "utf8")).toBe("earlier");
  });

  it("removes the disk it made when its runner never starts", async () => {
    const h = await make();
    h.runFails = true;
    await expect(h.adapter.launch(onHostVm(cases.gitSource))).rejects.toThrow(/failed to create/);
    expect(await exists(joinPath(h.dataDir, "sealant-vm-run-golden-1"))).toBe(false);
  });
});

describe("HostVmRuntimeAdapter · staged secrets (review R1)", () => {
  it("leaves no boot-env.json behind a boot that fails", async () => {
    const h = await make();
    const name = "sealant-vm-run-golden-4";
    h.exitOnBoot = 1;
    await expect(h.adapter.launch(onHostVm(cases.capture))).rejects.toBeInstanceOf(
      LaunchRetainedError,
    );
    // Kept for its work, and its secrets are not.
    expect(await exists(joinPath(h.dataDir, name, "data.img"))).toBe(true);
    expect(await exists(joinPath(h.controlDir, name, "boot-env.json"))).toBe(false);
  });

  it("takes the capture token back off disk when a recovery runner never starts", async () => {
    const h = await make();
    await h.adapter.launch(onHostVm(cases.capture));
    const name = "sealant-vm-run-golden-4";
    await h.adapter.stop({ resourceId: name, phase: "end" });
    h.runFails = true;
    await expect(
      h.adapter.recover({
        resourceId: name,
        runId: "run-golden-4",
        secretEnv: { SEALANT_CAPTURE_TOKEN: "capture-only" },
      }),
    ).rejects.toThrow(/failed to create/);
    const staged = await readFile(joinPath(h.controlDir, name, "recovery-env.json"), "utf8");
    expect(staged).not.toContain("capture-only");
    expect(JSON.parse(staged)).toMatchObject({ mode: "recover", secretEnv: {} });
  });

  it("removes the control directory with the data disk", async () => {
    const h = await make();
    await h.adapter.launch(onHostVm(cases.gitSource));
    const name = "sealant-vm-run-golden-1";
    await h.adapter.stop({ resourceId: name });
    expect(await exists(joinPath(h.controlDir, name))).toBe(false);
    expect(await exists(joinPath(h.dataDir, name))).toBe(false);
  });
});

describe("HostVmRuntimeAdapter · a data directory that is not there", () => {
  it("refuses to say a disk is missing when the data directory itself is gone", async () => {
    const h = await make();
    await rm(h.dataDir, { recursive: true, force: true });
    await expect(h.adapter.inspect({ resourceId: "sealant-vm-run-x" })).rejects.toThrow(
      /data directory .* is missing/,
    );
  });
});

describe("HostVmRuntimeAdapter · its egress proxy", () => {
  it("loads the proxy before the runner and hands the guest the executor CA", async () => {
    const h = await make();
    await h.adapter.launch(onHostVm(cases.gitSource));
    const name = "sealant-vm-run-golden-1";
    expect(h.policies).toEqual([
      expect.objectContaining({
        container: name,
        document: expect.objectContaining({
          mode: "standard",
          hostPublicIps: ["203.0.113.7/32"],
          // The isolated network and the proxy's outbound one are refused, with every bridge.
          blockedCidrs: expect.arrayContaining(["172.17.0.0/16", "10.250.1.0/29", "10.250.2.0/29"]),
        }),
      }),
    ]);
    expect(await readFile(joinPath(h.controlDir, name, "executor-ca.pem"), "utf8")).toBe(
      EXECUTOR_CA_PEM,
    );
  });

  it("is refused a launch that carries no proxy launch, before anything is made", async () => {
    const h = await make();
    const { egressProxy: _none, ...bare } = onHostVm(cases.gitSource);
    await expect(h.adapter.launch(bare)).rejects.toThrow(/behind its egress proxy/);
    expect(runnerRun(h)).toEqual([]);
    expect(h.proxy.started).toEqual([]);
  });

  it("takes the proxy and both its networks with the executor", async () => {
    const h = await make();
    await h.adapter.launch(onHostVm(cases.gitSource));
    const name = "sealant-vm-run-golden-1";
    await h.adapter.stop({ resourceId: name });
    expect(h.proxy.removed).toEqual([name]);
    expect(h.networks.has(`${name}-isolated`)).toBe(false);
    expect(h.networks.has(`${name}-proxy-egress`)).toBe(false);
  });

  it("tells the runner a restricted policy's mode and the ports it allows", () => {
    expect(
      hostVmEgressFlags({
        mode: "restricted",
        allowHosts: [{ host: "db.example.com", ports: [5432, 443] }, { host: "git.example.com" }],
        allowMirrors: [{ name: "npm", port: 4873 }],
      }),
    ).toEqual({ egress: "restricted", allowTcpPorts: [4873, 5432] });
    expect(hostVmEgressFlags(undefined)).toEqual({ egress: "standard", allowTcpPorts: [] });
  });
});

/** A restricted policy that lets one host out on `ports`. */
const restrictedOn = (ports: number[]) => ({
  mode: "restricted" as const,
  allowHosts: [{ host: "git.example.com", ports }],
});

describe("HostVmRuntimeAdapter · a policy applied while the VM runs (review R2)", () => {
  it("holds a wider policy for the next start, a narrower one now", () => {
    const launched = { mode: "restricted" as const, allowTcpPorts: [5432] };
    // A port the runner drops, or no restriction at all: wider than its firewall.
    expect(hostVmRunnerWidens(launched, restrictedOn([22]))).toBe(true);
    expect(hostVmRunnerWidens(launched, { mode: "standard" })).toBe(true);
    expect(hostVmRunnerWidens(launched, undefined)).toBe(true);
    // The same ports or fewer, 80 and 443 always: the proxy refuses the rest now.
    expect(hostVmRunnerWidens(launched, restrictedOn([5432, 443]))).toBe(false);
    expect(hostVmRunnerWidens(launched, restrictedOn([]))).toBe(false);
    // A standard runner forwards every port to the proxy: anything holds now.
    expect(hostVmRunnerWidens({ mode: "standard", allowTcpPorts: [] }, restrictedOn([22]))).toBe(
      false,
    );
    // Nothing recorded of the runner: unknown, so the next start.
    expect(hostVmRunnerWidens(null, restrictedOn([]))).toBe(true);
  });
});

describe("HostVmRuntimeAdapter · admission (review R2)", () => {
  it("refuses a capture workspace whose paths a recovery boot would not keep", async () => {
    const h = await make();
    const support = (runtime: Record<string, unknown>, harnessHome?: string) =>
      h.adapter.supports({
        blueprint: {
          ...onHostVm(cases.capture).blueprint,
          runtime: { ...onHostVm(cases.capture).blueprint.runtime, ...runtime },
          sources: {
            ...cases.capture.blueprint.sources,
            workspace: {
              ...cases.capture.blueprint.sources.workspace,
              ...(harnessHome === undefined ? {} : { harnessHome }),
            },
          },
        },
      });
    expect(support({})).toEqual({ supported: true });
    expect(support({ workingDirectory: "/srv/repo", workspaceRoot: "/srv" })).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: expect.stringContaining("runtime.workingDirectory is /srv/repo"),
    });
    expect(support({}, "/opt/harness")).toMatchObject({
      supported: false,
      message: expect.stringContaining("sources.workspace.harnessHome is /opt/harness"),
    });
    expect(underRecoveredRoot("/home/dev/.claude")).toBe(true);
    expect(underRecoveredRoot("/workspace")).toBe(true);
    expect(underRecoveredRoot("/workspace/../etc")).toBe(false);
    expect(underRecoveredRoot("/workspacex")).toBe(false);
  });

  it("refuses Docker inside the VM on a custom base image", async () => {
    const h = await make();
    const blueprint = onHostVm(cases.dind).blueprint;
    expect(
      h.adapter.supports({
        blueprint: {
          ...blueprint,
          target: {
            ...blueprint.target,
            os: { family: "custom", mode: "require", baseImage: "registry.example/img:1" },
          },
        },
      }),
    ).toMatchObject({ supported: false, message: expect.stringContaining("managed base image") });
  });

  it("removes a runner its docker run created and could not start", async () => {
    const h = await make();
    h.runFailsAtStart = true;
    await expect(h.adapter.launch(onHostVm(cases.capture))).rejects.toThrow(/\/dev\/kvm/);
    // Not left "ended" for the next delivery to keep: it never ran.
    expect(h.containers.has("sealant-vm-run-golden-4")).toBe(false);
    await expect(h.adapter.launch(onHostVm(cases.capture))).resolves.toMatchObject({
      status: "ready",
    });
  });
});

/** What the caller's two sockets in a scope hold now (stand-ins: files with known contents). */
const callerSocketsIn = async (scope: string) => ({
  capture: await readFile(joinPath(scope, "capture.sock"), "utf8").catch(() => undefined),
  session: await readFile(joinPath(scope, "session.sock"), "utf8").catch(() => undefined),
});

describe("HostVmRuntimeAdapter · a control scope the caller named (SLNT-1332)", () => {
  const SCOPE = "mend-exec-1";
  /** The caller binds its two sockets in the scope before it creates the workspace. */
  const bindCallerSockets = async (h: HostVmHarness) => {
    const scope = joinPath(h.controlDir, SCOPE);
    await mkdir(scope, { recursive: true });
    await writeFile(joinPath(scope, "capture.sock"), "caller's capture relay");
    await writeFile(joinPath(scope, "session.sock"), "caller's session channel");
    return scope;
  };
  const bound = {
    capture: "caller's capture relay",
    session: "caller's session channel",
  };
  const mountOf = (run: readonly string[]) =>
    valuesOf(run, "--mount").find((mount) => mount.includes("target=/run/sealant"));

  it("boots the runner in that scope and leaves the caller's sockets bound there", async () => {
    const h = await make();
    const scope = await bindCallerSockets(h);
    const result = await h.adapter.launch({ ...onHostVm(cases.capture), controlScope: SCOPE });
    const name = "sealant-vm-run-golden-4";

    expect(result).toMatchObject({
      resourceId: name,
      controlScope: SCOPE,
      endpoint: `unix://${joinPath(scope, "control.sock")}`,
    });
    expect(mountOf(runnerRun(h))).toContain(`source=${scope},`);
    // The runner read its launch from the scope, and nothing was staged under its name.
    expect(h.stagedAtRun[0]).toMatchObject({ mode: "normal", launch: { mode: "normal" } });
    expect(await exists(joinPath(h.controlDir, name))).toBe(false);
    expect(await callerSocketsIn(scope)).toEqual(bound);
  });

  it("reports its container name as the scope when the launch names none", async () => {
    const h = await make();
    const result = await h.adapter.launch(onHostVm(cases.gitSource));
    expect(result.controlScope).toBe("sealant-vm-run-golden-1");
  });

  it("keeps the caller's sockets when a launch fails and removes what it staged", async () => {
    const h = await make();
    const scope = await bindCallerSockets(h);
    h.runFails = true;
    await expect(
      h.adapter.launch({ ...onHostVm(cases.gitSource), controlScope: SCOPE }),
    ).rejects.toThrow(/failed to create/);
    expect(await exists(joinPath(h.dataDir, "sealant-vm-run-golden-1"))).toBe(false);
    expect(await callerSocketsIn(scope)).toEqual(bound);
    expect(await exists(joinPath(scope, "recovery-env.json"))).toBe(false);
    expect(await exists(joinPath(scope, `${HOST_VM_KEY}.config.json`))).toBe(false);
  });

  it("recovers a pruned runner in the scope it was launched in, its sockets untouched", async () => {
    const h = await make();
    const scope = await bindCallerSockets(h);
    await h.adapter.launch({ ...onHostVm(cases.capture), controlScope: SCOPE });
    const name = "sealant-vm-run-golden-4";
    await h.adapter.stop({ resourceId: name, phase: "end" });
    h.containers.delete(name);
    h.stagedAtRun.length = 0;

    // A recovery names no scope: the runner's own disk says which.
    const outcome = await h.adapter.recover({
      resourceId: name,
      runId: "run-golden-4",
      secretEnv: { SEALANT_CAPTURE_TOKEN: "capture-only" },
    });
    expect(outcome).toEqual({ outcome: "restarted" });
    const run = h.calls.filter((args) => args[0] === "run" && args.includes("--name")).at(-1) ?? [];
    expect(mountOf(run)).toContain(`source=${scope},`);
    expect(h.stagedAtRun[0]).toMatchObject({
      mode: "recover",
      launch: { secretEnv: { SEALANT_CAPTURE_TOKEN: "capture-only" } },
    });
    expect(await callerSocketsIn(scope)).toEqual(bound);
    expect(await h.adapter.locate({ runId: "run-golden-4" })).toMatchObject({
      controlScope: SCOPE,
      endpoint: `unix://${joinPath(scope, "control.sock")}`,
    });
  });

  it("takes the whole scope when the executor is removed for good", async () => {
    const h = await make();
    const scope = await bindCallerSockets(h);
    await h.adapter.launch({ ...onHostVm(cases.gitSource), controlScope: SCOPE });
    await h.adapter.stop({ resourceId: "sealant-vm-run-golden-1" });
    expect(await exists(scope)).toBe(false);
  });
});
