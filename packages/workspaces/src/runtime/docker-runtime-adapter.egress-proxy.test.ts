/**
 * A proxy-backed Docker workspace (restricted egress, or a brokered secret) through the adapter's
 * public interface: an in-memory Docker host, and the proxy's admin socket as a real HTTP server
 * on the very path the adapter dials, recording what the proxy was told.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { EGRESS_PROXY_GATE_SCRIPT } from "./docker-egress-proxy.js";
import { parseDockerEgressPolicy } from "./docker-egress.js";
import { DockerRuntimeAdapter } from "./docker-runtime-adapter.js";
import { buildProxyPolicyDocument } from "./egress-proxy-policy.js";
import { generateExecutorCa } from "./executor-ca.js";
import {
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterSupportInput,
} from "./runtime-adapter.js";

const SECRET_VALUE = "Bearer sk-live-never-in-argv";

const BROKERED = {
  secretId: "psec_vercel",
  name: "VERCEL_TOKEN",
  placeholder: "mend_sec_0123456789abcdefghijklmn",
  secretRef: "ref-vercel",
  headerName: "Authorization",
  bindHosts: ["api.vercel.com"],
};

const blueprint = (extra: Record<string, unknown> = {}) => ({
  sources: { workspace: { kind: "git", url: "https://github.com/example/repo.git" } },
  harness: { id: "opencode" },
  networkPolicy: {
    mode: "restricted",
    policyHash: "sha256:policy",
    allowHosts: [{ host: "registry.npmjs.org" }],
  },
  brokeredSecrets: [BROKERED],
  ...extra,
});

const publication = {
  kind: "oci",
  publicationId: "fixture-publication",
  image: {
    repository: "sealant/workspaces/demo",
    tag: "opencode",
    reference: "127.0.0.1:5000/sealant/workspaces/demo:opencode",
    digestReference: "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
    digest: "sha256:test",
  },
  evidence: {},
};

/** Docker's answer about something it does not have. */
const noSuch = (what: string) =>
  Object.assign(new Error("failed"), { stderr: `Error: No such ${what}` });

/** A Docker host in memory, answering what a proxy-backed launch asks of it. */
const dockerHost = (options: { readonly engine?: string } = {}) => {
  const calls: string[][] = [];
  const networks = new Map<string, Set<string>>();
  const containers = new Map<string, { running: boolean; labels: Record<string, string> }>();
  const run = vi.fn(async (_command: string, args: Array<string>) => {
    calls.push([...args]);
    const last = args.at(-1) ?? "";
    const [verb, sub] = args;
    if (verb === "version") return { stdout: `${options.engine ?? "28.1.0"}\n`, stderr: "" };
    if (verb === "network" && sub === "create") {
      networks.set(last, new Set());
      return { stdout: `${last}-id\n`, stderr: "" };
    }
    if (verb === "network" && sub === "ls") return { stdout: "bridge-1\n", stderr: "" };
    if (verb === "network" && sub === "inspect" && args.includes("{{json .IPAM.Config}}")) {
      return { stdout: '[{"Subnet":"192.0.10.0/24","Gateway":"192.0.10.1"}]\n', stderr: "" };
    }
    if (verb === "network" && sub === "inspect") {
      const name = last.replace(/-id$/, "");
      const members = networks.get(name);
      if (members === undefined) throw noSuch("network");
      return {
        stdout: args.some((arg) => arg.startsWith("{{range"))
          ? [...members].join("\n")
          : `${name}-id\n`,
        stderr: "",
      };
    }
    if (verb === "network" && sub === "rm") {
      networks.delete(last.replace(/-id$/, ""));
      return { stdout: "", stderr: "" };
    }
    if (verb === "network" && (sub === "connect" || sub === "disconnect")) {
      const set = networks.get(args.at(-2) ?? "");
      if (sub === "connect") set?.add(last);
      else set?.delete(last);
      return { stdout: "", stderr: "" };
    }
    if (verb === "create") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      containers.set(name, { running: false, labels: {} });
      networks.get(args[args.indexOf("--network") + 1] ?? "")?.add(name);
      return { stdout: `${name}-cid\n`, stderr: "" };
    }
    if (verb === "start" || verb === "stop" || verb === "kill") {
      const container = containers.get(last.replace(/-cid$/, ""));
      if (container === undefined) throw noSuch("container");
      container.running = verb === "start";
      return { stdout: "", stderr: "" };
    }
    if (verb === "rm") {
      const name = last.replace(/-cid$/, "");
      containers.delete(name);
      for (const members of networks.values()) members.delete(name);
      return { stdout: "", stderr: "" };
    }
    if (verb === "image")
      return { stdout: '["/usr/local/bin/sealantd","boot"]\tnull\n', stderr: "" };
    if (verb === "run" && args.includes("NET_ADMIN")) return { stdout: "", stderr: "" };
    if (verb === "run" && args.includes("cat")) {
      return { stdout: "# ExtServers: [host(127.0.0.53)]\n", stderr: "" };
    }
    if (verb === "run" && args.includes("ip")) return { stdout: "", stderr: "" };
    if (verb === "run") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      const labels = Object.fromEntries(
        args.flatMap((arg, index) => {
          if (args[index - 1] !== "--label") return [];
          const [key = "", value = ""] = arg.split("=");
          return [[key, value] as const];
        }),
      );
      containers.set(name, { running: true, labels });
      return { stdout: `${name}-cid\n`, stderr: "" };
    }
    if (verb === "inspect") {
      const format = args[2] ?? "";
      const name = last.replace(/-cid$/, "");
      const container = containers.get(name);
      if (container === undefined) throw noSuch("container");
      if (format.includes("NetworkSettings")) {
        return {
          stdout: JSON.stringify({
            [`${name}-isolated`]: {
              NetworkID: `${name}-isolated-id`,
              IPAddress: "10.233.0.2",
              IPPrefixLen: 28,
            },
          }),
          stderr: "",
        };
      }
      if (format.includes("{{json .State}}")) {
        return {
          stdout: JSON.stringify({
            Status: container.running ? "running" : "exited",
            Running: container.running,
            ExitCode: 0,
            Error: "",
          }),
          stderr: "",
        };
      }
      if (format.includes("Labels"))
        return { stdout: `${container.labels["sealant.egress-proxy-backed"] ?? ""}\n`, stderr: "" };
      if (format.includes("{{.Name}}")) return { stdout: `/${name}\n`, stderr: "" };
      return { stdout: `${name}-cid\t${String(container.running)}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return { run, calls, networks, containers };
};

const subnetPool = () => {
  const held = new Map<string, string>();
  let next = 0;
  return {
    held,
    allocate: async ({ name }: { name: string; owner: string }) => {
      const subnet = held.get(name) ?? `10.233.0.${String(16 * next++)}/28`;
      held.set(name, subnet);
      return subnet;
    },
    release: async (name: string) => {
      held.delete(name);
    },
  };
};

/** The proxy's admin socket: answers like the proxy and records each request. */
const adminSocket = async (path: string) => {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/health") {
        res.end(
          JSON.stringify({
            initialized: false,
            revocationWatermark: 0,
            activeConnections: 0,
            leaseRemainingMs: 0,
            leaseExpired: true,
            resyncRequired: false,
          }),
        );
        return;
      }
      if (req.url === "/v1/policy") {
        const doc = z
          .object({ policyHash: z.string(), revocationWatermark: z.number() })
          .parse(JSON.parse(body));
        res.end(
          JSON.stringify({
            ok: true,
            policyHash: doc.policyHash,
            revocationWatermark: doc.revocationWatermark,
            closed: 0,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found", message: "no such route" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

describe("a Docker workspace behind its own egress proxy", () => {
  let controlDir: string;
  let socket: Awaited<ReturnType<typeof adminSocket>> | undefined;
  const ca = generateExecutorCa({ executor: "sealant-run-1" });

  beforeEach(async () => {
    controlDir = await mkdtemp(join(tmpdir(), "sealant-proxied-"));
    await mkdir(join(controlDir, "sealant-run-1-proxy"), { recursive: true });
    socket = await adminSocket(join(controlDir, "sealant-run-1-proxy", "proxy-admin.sock"));
  });
  afterEach(async () => {
    await socket?.close();
    await rm(controlDir, { recursive: true, force: true });
  });

  const adapterOn = (docker: ReturnType<typeof dockerHost>, pool = subnetPool()) =>
    new DockerRuntimeAdapter({
      commandRunner: docker.run,
      runtimeCatalogLoader: async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) }),
      verifyRunning: false,
      controlSocketHostDir: controlDir,
      egress: {
        policy: parseDockerEgressPolicy({
          workspaceSubnets: "10.233.0.0/16",
          reachSubnets: "10.231.0.0/16",
          resourceEgressSubnets: "10.232.0.0/16",
          operatorAllowedPrivateEgress: "10.42.0.0/16",
          hostPublicIps: "203.0.113.9",
        }),
        subnets: pool,
      },
      egressProxy: { image: "egress-proxy:test", ownControlDirectory: async () => undefined },
    });

  const launchInput = (extra: Record<string, unknown> = {}) =>
    parseRuntimeAdapterLaunchInput({
      blueprint: parseRuntimeAdapterSupportInput({ blueprint: blueprint(extra) }).blueprint,
      publication,
      runId: "run-1",
      egressProxy: {
        prepare: async ({
          host,
        }: {
          host: Parameters<typeof buildProxyPolicyDocument>[0]["host"];
        }) => ({
          caCertPem: ca.certPem,
          document: buildProxyPolicyDocument({
            networkPolicy: { mode: "restricted", policyHash: "sha256:policy" },
            brokeredSecrets: [BROKERED],
            brokeredValues: Redacted.make({ "ref-vercel": SECRET_VALUE }),
            ca,
            tombstones: { revocationWatermark: 0, revokedHosts: [], revokedSecretIds: [] },
            host,
          }),
        }),
      },
    });

  it("loads the proxy's policy before the workspace exists, and runs the workspace only through it", async () => {
    const docker = dockerHost();
    await adapterOn(docker).launch(launchInput());

    const workspaceRun = docker.calls.findIndex(
      (call) => call[0] === "run" && call.includes("sealant-run-1"),
    );
    const proxyStart = docker.calls.findIndex(
      (call) => call[0] === "start" && call.at(-1) === "sealant-run-1-proxy",
    );
    expect(proxyStart).toBeGreaterThanOrEqual(0);
    expect(workspaceRun).toBeGreaterThan(proxyStart);
    // The proxy was told its whole policy (and only then the workspace ran).
    const policy = socket?.requests.find((request) => request.url === "/v1/policy");
    expect(policy?.method).toBe("PUT");
    const document = z.record(z.string(), z.unknown()).parse(JSON.parse(policy?.body ?? "{}"));
    expect(document).toMatchObject({
      mode: "restricted",
      leaseTtlSecs: 120,
      operatorAllowedPrivateCidrs: ["10.42.0.0/16"],
      hostPublicIps: ["203.0.113.9/32"],
      executorCaCertPem: ca.certPem,
      brokeredSecrets: [
        expect.objectContaining({ value: SECRET_VALUE, headerName: "Authorization" }),
      ],
    });
    expect(document["blockedCidrs"]).toEqual(
      expect.arrayContaining(["192.0.10.0/24", "192.0.10.1/32", "10.233.0.17/32", "10.233.0.0/28"]),
    );

    const args = docker.calls[workspaceRun] ?? [];
    const networks = args.flatMap((arg, index) => (args[index - 1] === "--network" ? [arg] : []));
    expect(networks).toEqual(["sealant-run-1-isolated"]);
    expect(args[args.indexOf("--dns") + 1]).toBe("10.233.0.14");
    expect(args).toContain("HTTPS_PROXY=http://10.233.0.14:8080");
    expect(args).toContain("https_proxy=http://10.233.0.14:8080");
    expect(args).toContain(`SEALANT_EXECUTOR_CA_PEM=${ca.certPem}`);
    expect(args).toContain("SSL_CERT_FILE=/run/sealant-egress/ca-bundle.pem");
    expect(args).toContain("NODE_EXTRA_CA_CERTS=/run/sealant-egress/executor-ca.pem");
    expect(args).not.toContain("host.docker.internal:host-gateway");
    expect(args).toContain(EGRESS_PROXY_GATE_SCRIPT);
    expect(args).toEqual(expect.arrayContaining(["--cap-drop", "NET_RAW"]));
  });

  it("keeps a workspace with Docker inside on its isolated network: the Docker service joins it there", async () => {
    const docker = dockerHost();
    await adapterOn(docker).launch(
      launchInput({
        networkPolicy: { mode: "standard", policyHash: "sha256:policy" },
        tooling: { services: { docker: { enabled: true } } },
      }),
    );
    const args =
      docker.calls.find((call) => call[0] === "run" && call.includes("sealant-run-1")) ?? [];
    const networks = args.flatMap((arg, index) => (args[index - 1] === "--network" ? [arg] : []));
    expect(networks).toEqual(["sealant-run-1-isolated"]);
    expect(args).toContain("DOCKER_HOST=tcp://docker:2375");
    expect(docker.calls).toContainEqual([
      "network",
      "connect",
      "--alias",
      "docker",
      "sealant-run-1-isolated",
      "sealant-run-1-docker-cid",
    ]);
  });

  it("runs behind its proxy when the worker hands one for a stored host revocation alone", async () => {
    const docker = dockerHost();
    await adapterOn(docker).launch(
      launchInput({
        networkPolicy: { mode: "standard", policyHash: "sha256:policy" },
        brokeredSecrets: [],
      }),
    );
    const args =
      docker.calls.find((call) => call[0] === "run" && call.includes("sealant-run-1")) ?? [];
    expect(args[args.indexOf("--network") + 1]).toBe("sealant-run-1-isolated");
  });

  it("never puts a brokered secret's value or the CA's key into anything Docker sees", async () => {
    const docker = dockerHost();
    await adapterOn(docker).launch(launchInput());
    const everything = docker.calls.flat().join("\n");
    expect(everything).not.toContain(SECRET_VALUE);
    expect(everything).not.toContain("PRIVATE KEY");
  });

  it("puts the proxy on the isolated network at its fixed address, and its mirrors and route out apart", async () => {
    const docker = dockerHost();
    await adapterOn(docker).launch(launchInput());
    const create = docker.calls.find((call) => call[0] === "create") ?? [];
    expect(create).toEqual(
      expect.arrayContaining([
        "--network",
        "sealant-run-1-isolated",
        "--ip",
        "10.233.0.14",
        "--read-only",
      ]),
    );
    expect(docker.networks.get("sealant-run-1-proxy-egress")?.has("sealant-run-1-proxy")).toBe(
      true,
    );
    expect(docker.networks.get("sealant-run-1-isolated")).toEqual(new Set(["sealant-run-1-proxy"]));
  });

  it("refuses the launch, with nothing started, on an engine that cannot isolate the network", async () => {
    const docker = dockerHost({ engine: "27.5.1" });
    await expect(adapterOn(docker).launch(launchInput())).rejects.toThrow(
      /cannot isolate a workspace/,
    );
    expect(docker.calls.some((call) => call[0] === "run" && call.includes("sealant-run-1"))).toBe(
      false,
    );
    expect(docker.calls.some((call) => call[0] === "create")).toBe(false);
  });

  it("refuses a launch that brings no executor CA or policy for its proxy", async () => {
    const docker = dockerHost();
    const input = parseRuntimeAdapterLaunchInput({
      blueprint: parseRuntimeAdapterSupportInput({ blueprint: blueprint() }).blueprint,
      publication,
      runId: "run-1",
    });
    await expect(adapterOn(docker).launch(input)).rejects.toThrow(/carries no executor CA/);
  });

  it("parks the proxy with a retained executor's sidecar, and removes it with the workspace", async () => {
    const docker = dockerHost();
    const pool = subnetPool();
    const adapter = adapterOn(docker, pool);
    const launched = await adapter.launch(launchInput());
    const workspace = docker.containers.get("sealant-run-1");
    if (workspace !== undefined) workspace.running = false;
    expect(
      await adapter.parkRetained({ resourceId: launched.resourceId, reference: "sealant-run-1" }),
    ).toEqual({
      stopped: ["sealant-run-1-proxy"],
    });
    expect(docker.containers.get("sealant-run-1-proxy")?.running).toBe(false);

    await adapter.stop({
      resourceId: launched.resourceId,
      reference: "sealant-run-1",
      phase: "remove",
    });
    expect(docker.containers.has("sealant-run-1-proxy")).toBe(false);
    expect(docker.networks.has("sealant-run-1-isolated")).toBe(false);
    expect(docker.networks.has("sealant-run-1-proxy-egress")).toBe(false);
    expect(pool.held.size).toBe(0);
  });

  it("recovers a retained proxy-backed workspace with its proxy left off", async () => {
    const docker = dockerHost();
    const adapter = adapterOn(docker);
    const launched = await adapter.launch(launchInput());
    const workspace = docker.containers.get("sealant-run-1");
    if (workspace !== undefined) workspace.running = false;
    await adapter.parkRetained({ resourceId: launched.resourceId, reference: "sealant-run-1" });
    const before = docker.calls.length;
    expect(
      await adapter.recover({ resourceId: launched.resourceId, reference: "sealant-run-1" }),
    ).toEqual({
      outcome: "restarted",
    });
    const recoveryCalls = docker.calls.slice(before);
    expect(
      recoveryCalls.some((call) => call[0] === "start" && call.at(-1) === "sealant-run-1-proxy"),
    ).toBe(false);
    expect(docker.containers.get("sealant-run-1-proxy")?.running).toBe(false);
  });
});

describe("admission of a network policy on Docker", () => {
  const supports = (adapter: DockerRuntimeAdapter, extra: Record<string, unknown>) =>
    adapter.supports({
      blueprint: parseRuntimeAdapterSupportInput({ blueprint: blueprint(extra) }).blueprint,
    });
  const plain = new DockerRuntimeAdapter({ commandRunner: vi.fn() });

  it("refuses VM isolation and points at host-vm", () => {
    expect(
      supports(plain, {
        networkPolicy: { mode: "standard", policyHash: "h", requireVmIsolation: true },
        brokeredSecrets: [],
      }),
    ).toMatchObject({ supported: false, message: expect.stringContaining("host-vm") });
  });

  it("refuses restricted egress with Docker inside", () => {
    expect(supports(plain, { tooling: { services: { docker: { enabled: true } } } })).toMatchObject(
      {
        supported: false,
        message: expect.stringContaining("Docker inside a Docker workspace"),
      },
    );
  });

  it("refuses a brokered secret, even under standard egress, where no proxy is configured", () => {
    expect(supports(plain, { networkPolicy: { mode: "standard", policyHash: "h" } })).toMatchObject(
      { supported: false, message: expect.stringContaining("egress proxy") },
    );
    expect(
      supports(plain, {
        networkPolicy: { mode: "standard", policyHash: "h" },
        brokeredSecrets: [],
      }),
    ).toEqual({
      supported: true,
    });
  });
});
