import { describe, expect, it } from "vitest";

import { DEFAULT_NETWORK_GUARD_IMAGE } from "../runtime/docker-runtime-adapter.js";
import {
  connectArgv,
  coverImageVolumes,
  egressNetworkName,
  execArgv,
  instanceContainerName,
  instanceRunArgv,
  instanceVolumeName,
  networkCreateArgv,
  parseImageVolumes,
  probeArgv,
  reachNetworkName,
} from "./docker-resource-argv.js";
import { DOMAIN, instanceRecord, POSTGRES_IMAGE, postgresSpec } from "./resource.fixture.js";

const instance = instanceRecord();

describe("resource instance names", () => {
  it("names the container, its volumes and its networks outside the workspace prefix", () => {
    expect(instanceContainerName(instance.id)).toBe("sealres-0a1b2c3d4e5f");
    expect(instanceVolumeName(instance.id, "data")).toBe("sealres-0a1b2c3d4e5f-data");
    expect(egressNetworkName(instance.id)).toBe("sealres-0a1b2c3d4e5f-egress");
    expect(reachNetworkName("sealant-run-1")).toBe("sealant-run-1-reach");
    expect(instanceContainerName(instance.id).startsWith("sealant-")).toBe(false);
  });
});

describe("coverImageVolumes", () => {
  it("keeps a spec volume that mounts the image's VOLUME, and adds nothing", () => {
    expect(coverImageVolumes(instance.spec.volumes, ["/var/lib/postgresql"])).toEqual([
      { name: "data", mountPath: "/var/lib/postgresql" },
    ]);
  });

  it("covers every image VOLUME no spec volume mounts exactly with a named volume", () => {
    const covered = coverImageVolumes(
      [{ name: "data", mountPath: "/srv/data" }],
      parseImageVolumes('{"/var/lib/postgresql":{},"/srv/data":{}}'),
    );
    expect(covered).toEqual([
      { name: "data", mountPath: "/srv/data" },
      { name: expect.stringMatching(/^img-[0-9a-f]{8}$/), mountPath: "/var/lib/postgresql" },
    ]);
    expect(coverImageVolumes([], ["/var/lib/postgresql"])).toEqual(
      coverImageVolumes([], ["/var/lib/postgresql"]),
    );
  });

  it("reads an image with no VOLUME", () => {
    expect(parseImageVolumes("null\n")).toEqual([]);
  });
});

describe("instanceRunArgv", () => {
  const argv = instanceRunArgv(instance, instance.spec.volumes);

  it("lowers a Postgres instance to this exact argv", () => {
    expect(argv).toEqual([
      "run",
      "-d",
      "--name",
      "sealres-0a1b2c3d4e5f",
      "--hostname",
      "db",
      "--label",
      "sealant.resource-instance=rin:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "--label",
      `sealant.resource-domain=${DOMAIN}`,
      "--label",
      `sealant.resource-spec-digest=sha256:${"c".repeat(64)}`,
      "--restart",
      "no",
      "--stop-timeout",
      "60",
      "--security-opt",
      "no-new-privileges:true",
      "--cap-drop",
      "NET_RAW",
      "--pids-limit",
      "1024",
      "--memory",
      "1073741824",
      "--cpus",
      "1.5",
      "--network",
      "sealres-0a1b2c3d4e5f-egress",
      "--mount",
      "type=volume,src=sealres-0a1b2c3d4e5f-data,dst=/var/lib/postgresql",
      "--env",
      "PGDATA=/var/lib/postgresql/18/docker",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      POSTGRES_IMAGE,
    ]);
  });

  it("asks for nothing a spec may not have", () => {
    const flags = argv.filter((arg) => arg.startsWith("-"));
    for (const refused of [
      "--privileged",
      "--cap-add",
      "-v",
      "--volume",
      "--device",
      "--pid",
      "--ipc",
      "--userns",
      "--uts",
    ]) {
      expect(flags).not.toContain(refused);
    }
    expect(argv.join(" ")).not.toMatch(/--network host|type=bind|docker\.sock/);
  });

  it("replaces the image's CMD with the spec's command, after the image", () => {
    const redis = instanceRecord({
      spec: postgresSpec({ alias: "cache", command: ["redis-server", "--appendonly", "yes"] }),
    });
    expect(instanceRunArgv(redis, []).slice(-4)).toEqual([
      POSTGRES_IMAGE,
      "redis-server",
      "--appendonly",
      "yes",
    ]);
  });
});

describe("network, exec and probe argv", () => {
  it("creates reach networks internal and egress networks routed, each on Core's subnet", () => {
    expect(networkCreateArgv("sealant-run-1-reach", "reach", "10.231.0.0/27")).toEqual([
      "network",
      "create",
      "--driver",
      "bridge",
      "--internal",
      "--subnet",
      "10.231.0.0/27",
      "--label",
      "sealant.resource-network=reach",
      "sealant-run-1-reach",
    ]);
    expect(networkCreateArgv("sealres-x-egress", "egress", "10.232.0.16/28")).not.toContain(
      "--internal",
    );
  });

  it("joins an instance under its alias", () => {
    expect(
      connectArgv({ network: "sealant-run-1-reach", container: "sealres-x", alias: "db" }),
    ).toEqual(["network", "connect", "--alias", "db", "sealant-run-1-reach", "sealres-x"]);
  });

  it("execs with stdin open, and the argv only as the process's arguments", () => {
    expect(execArgv("sealres-x", { argv: ["psql", "-c", "select 1"], user: "postgres" })).toEqual([
      "exec",
      "-i",
      "--user",
      "postgres",
      "sealres-x",
      "psql",
      "-c",
      "select 1",
    ]);
  });

  it("probes tcp from the guard image with no capability, and exec in the instance", () => {
    expect(
      probeArgv("sealres-x", { kind: "tcp", port: 6379 }, DEFAULT_NETWORK_GUARD_IMAGE),
    ).toEqual([
      "run",
      "--rm",
      "--network",
      "container:sealres-x",
      "--cap-drop",
      "ALL",
      "--user",
      "65534",
      "--entrypoint",
      "nc",
      DEFAULT_NETWORK_GUARD_IMAGE,
      "-z",
      "-w",
      "2",
      "127.0.0.1",
      "6379",
    ]);
    expect(probeArgv("sealres-x", instance.spec.ready, DEFAULT_NETWORK_GUARD_IMAGE)).toEqual([
      "exec",
      "--user",
      "postgres",
      "sealres-x",
      "pg_isready",
      "-U",
      "postgres",
    ]);
  });
});
