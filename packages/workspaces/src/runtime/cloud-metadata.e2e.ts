/**
 * The cloud metadata address against a real Docker daemon: a default workspace, and every container
 * its Docker service runs, is refused at once; an opted-in workspace reaches it; the mirrors and the
 * deployment's shared network stay reachable.
 *
 * The metadata address is real here: a server at 169.254.169.254 on the deployment's shared
 * workspace network, a layer-2-only bridge (`inhibit_ipv4`), so the Docker host itself gets no route
 * to 169.254.169.0/24 and keeps its own metadata service. A Docker Hub pull-through registry stands
 * in for the Docker mirror, and a plain HTTP server on the shared network for the npm mirror, the
 * bucket and the control plane.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DockerRuntimeAdapter, type DockerCommandRunner } from "./docker-runtime-adapter.js";
import { parseRuntimeAdapterLaunchInput } from "./runtime-adapter.js";

const execFileAsync = promisify(execFile);
const docker: DockerCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
};

/** A command's output, failed or not, and how long it took. */
const attempt = async (
  args: readonly string[],
): Promise<{ ok: boolean; output: string; ms: number }> => {
  const started = Date.now();
  try {
    const result = await docker("docker", [...args]);
    return { ok: true, output: result.stdout + result.stderr, ms: Date.now() - started };
  } catch (error) {
    const output =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr)
        : String(error);
    return { ok: false, output, ms: Date.now() - started };
  }
};

const METADATA_URL = "http://169.254.169.254/latest/meta-data";
const PERSON_UID = "40001";
const tag = `${process.pid}`;
const sharedNetwork = `sealant-metadata-e2e-${tag}`;
const metadataServer = `sealant-metadata-e2e-server-${tag}`;
const appServer = `sealant-metadata-e2e-app-${tag}`;
const dockerMirror = `sealant-metadata-e2e-mirror-${tag}`;

describe("the cloud metadata address", () => {
  let fixtureDir: string | undefined;
  let image: string | undefined;
  let adapter: DockerRuntimeAdapter;
  const launched: Array<{ readonly resourceId: string; readonly reference: string }> = [];
  let guarded = "missing-workspace";
  let reachable = "missing-workspace";

  const launch = async (runId: string, cloudMetadata: boolean, dockerService: boolean) => {
    if (fixtureDir === undefined || image === undefined) throw new Error("no fixture");
    const result = await adapter.launch(
      parseRuntimeAdapterLaunchInput({
        runId,
        blueprint: {
          version: "1",
          sources: { workspace: { kind: "mount", hostPath: fixtureDir }, inputs: [], mounts: [] },
          harness: { id: "opencode" },
          access: { ssh: { enabled: false, listenPort: 2222 } },
          tooling: { packages: [], services: { docker: { enabled: dockerService } } },
          lifecycle: { setup: [], startup: { steps: [], foreground: { kind: "harness" } } },
          runtime: {
            env: {},
            credentialRefs: [],
            workspaceRoot: "/workspace",
            workingDirectory: "/workspace/repo",
            persistence: "ephemeral",
            ociRuntime: "runc",
            network: { outbound: true, cloudMetadata },
          },
          target: {
            os: { family: "arch", mode: "prefer" },
            runtime: { family: "docker", mode: "require" },
          },
        },
        publishedImage: {
          repository: "sealant/metadata-fixture",
          tag: "e2e",
          reference: image,
          digestReference: image,
          digest: "sha256:e2e-fixture",
        },
      }),
    );
    launched.push({ resourceId: result.resourceId, reference: result.reference });
    return result.resourceId;
  };

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "sealant-metadata-"));
    image = `sealant-metadata-fixture:${tag}`;
    await writeFile(
      join(fixtureDir, "Dockerfile"),
      [
        // Alpine with the Docker CLI, busybox `wget` and `ip`, and a per-person user.
        "FROM docker:27.5.1-cli",
        `RUN mkdir -p /workspace/repo && adduser -D -u ${PERSON_UID} person`,
        'ENTRYPOINT ["sleep"]',
        'CMD ["infinity"]',
        "",
      ].join("\n"),
    );
    await docker("docker", ["build", "-t", image, fixtureDir]);

    await docker("docker", [
      "network",
      "create",
      "--internal",
      "--subnet",
      "169.254.169.0/24",
      "--opt",
      "com.docker.network.bridge.inhibit_ipv4=true",
      sharedNetwork,
    ]);
    const serve = (name: string, network: string[], body: string) =>
      docker("docker", [
        "run",
        "-d",
        "--name",
        name,
        ...network,
        "busybox:1.37",
        "sh",
        "-c",
        `mkdir -p /www/latest && echo ${body} > /www/latest/meta-data && echo ${body} > /www/index.html && exec httpd -f -p 80 -h /www`,
      ]);
    await serve(metadataServer, ["--network", sharedNetwork, "--ip", "169.254.169.254"], "i-e2e");
    await serve(
      appServer,
      ["--network", sharedNetwork, "--ip", "169.254.169.10", "--network-alias", "npm-mirror"],
      "mirror-ok",
    );
    await docker("docker", [
      "run",
      "-d",
      "--name",
      dockerMirror,
      "-e",
      "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io",
      "registry:2.8.3",
    ]);

    adapter = new DockerRuntimeAdapter({
      commandRunner: docker,
      runtimeCatalogLoader: async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) }),
      verifyRunning: false,
      mountAllowedStoreRoots: fixtureDir,
      workspaceNetwork: sharedNetwork,
      registryMirrors: ["http://docker-mirror:5000"],
      registryMirrorContainer: dockerMirror,
      // `sleep` as PID 1 ignores SIGTERM: no flush to wait for.
      stopGraceSeconds: 1,
    });
    guarded = await launch(`metadata-guarded-${tag}`, false, true);
    reachable = await launch(`metadata-reachable-${tag}`, true, false);
  }, 300_000);

  afterAll(async () => {
    for (const workspace of launched) {
      await adapter.stop(workspace).catch(() => undefined);
    }
    for (const name of [metadataServer, appServer, dockerMirror]) {
      await docker("docker", ["rm", "-f", name]).catch(() => undefined);
    }
    await docker("docker", ["network", "rm", sharedNetwork]).catch(() => undefined);
    if (image !== undefined) {
      await docker("docker", ["image", "rm", "-f", image]).catch(() => undefined);
    }
    if (fixtureDir !== undefined) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("is refused at once from a workspace, for root and a per-person user", async () => {
    for (const user of ["0", PERSON_UID]) {
      const probe = await attempt([
        "exec",
        "-u",
        user,
        guarded,
        "wget",
        "-T",
        "20",
        "-qO-",
        METADATA_URL,
      ]);
      expect(probe.ok).toBe(false);
      expect(probe.output).toContain("Permission denied");
      expect(probe.ms).toBeLessThan(5_000);
    }
    const routes = await docker("docker", ["exec", guarded, "ip", "-6", "route", "show"]);
    expect(routes.stdout).toContain("prohibit fd00:ec2::254");
  });

  it("stays refused: neither root nor a per-person user in the workspace can remove the route", async () => {
    for (const user of ["0", PERSON_UID]) {
      const removal = await attempt([
        "exec",
        "-u",
        user,
        guarded,
        "ip",
        "route",
        "del",
        "prohibit",
        "169.254.169.254/32",
      ]);
      expect(removal.ok).toBe(false);
      expect(removal.output).toContain("Operation not permitted");
    }
    const probe = await attempt(["exec", guarded, "wget", "-T", "20", "-qO-", METADATA_URL]);
    expect(probe.output).toContain("Permission denied");
  });

  it("is refused at once from a container the workspace's Docker service runs", async () => {
    // Timed inside the nested container, so its own start does not count.
    const timed = `start=$(date +%s); wget -T 20 -qO- ${METADATA_URL}; echo "rc=$? seconds=$(( $(date +%s) - start ))"`;
    const nested = await docker("docker", [
      "exec",
      guarded,
      "docker",
      "run",
      "--rm",
      "alpine:3.20",
      "sh",
      "-c",
      timed,
    ]);
    const output = nested.stdout + nested.stderr;
    expect(output).toContain("Connection refused");
    expect(output).not.toContain("rc=0");
    expect(Number(/seconds=(\d+)/.exec(output)?.[1] ?? "99")).toBeLessThan(5);

    // A privileged nested container with the host network sits in the rootless daemon's own
    // namespace, below the guarded one: it cannot see the route, let alone remove it.
    const privileged = await attempt([
      "exec",
      guarded,
      "docker",
      "run",
      "--rm",
      "--privileged",
      "--network",
      "host",
      "alpine:3.20",
      "sh",
      "-c",
      `ip route del prohibit 169.254.169.254/32; ${timed}`,
    ]);
    expect(privileged.output).toContain("Connection refused");
    expect(privileged.output).not.toContain("rc=0");
  }, 120_000);

  it("is reached from a workspace that opted in", async () => {
    const probe = await docker("docker", [
      "exec",
      reachable,
      "wget",
      "-T",
      "20",
      "-qO-",
      METADATA_URL,
    ]);
    expect(probe.stdout.trim()).toBe("i-e2e");
    const routes = await docker("docker", ["exec", reachable, "ip", "route", "show"]);
    expect(routes.stdout).not.toContain("prohibit");
  });

  it("leaves the shared network and the Docker mirror reachable from a refused workspace", async () => {
    const app = await docker("docker", [
      "exec",
      guarded,
      "wget",
      "-T",
      "20",
      "-qO-",
      "http://npm-mirror/",
    ]);
    expect(app.stdout.trim()).toBe("mirror-ok");

    await docker("docker", ["exec", guarded, "docker", "pull", "-q", "busybox:1.36"]);
    const catalog = await docker("docker", [
      "exec",
      dockerMirror,
      "wget",
      "-qO-",
      "http://127.0.0.1:5000/v2/_catalog",
    ]);
    expect(catalog.stdout).toContain("library/busybox");
  }, 120_000);
});
