/**
 * Resource instances against a real Docker daemon. Two stand-in workspace executors (busybox
 * containers, each on a network of its own, as a workspace is on its `<run>-network`) are linked
 * to one domain under worktree keys `w1` and `w2`; a Postgres instance serves the project and a
 * Redis instance serves `w1` only.
 *
 * Run: `pnpm --filter @sealant/workspaces test:e2e src/resources/docker-resource-runtime.e2e.ts`.
 * Everything it creates carries its tag in the name, and it removes exactly those names.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { ResourceInstanceId } from "@sealant/api-contracts";
import { resourceInstanceSpecDigest, type ResourceInstanceRecord } from "@sealant/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  egressNetworkName,
  instanceContainerName,
  instanceVolumeName,
  reachNetworkName,
} from "./docker-resource-argv.js";
import { DockerResourceRuntime, type ResourceSubnets } from "./docker-resource-runtime.js";
import { desiredAttachments } from "./reach.js";
import { instanceRecord, linkedExecutor, postgresSpec } from "./resource.fixture.js";

const execFileAsync = promisify(execFile);
const docker = async (...args: string[]) =>
  (await execFileAsync("docker", args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const succeeds = (...args: string[]) =>
  docker(...args).then(
    () => true,
    () => false,
  );

const POSTGRES =
  "postgres:18-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5";
const REDIS =
  "redis:7-alpine@sha256:57e4255cc971b1c8d6f8a6ca283ac01bc3ecdd914273ef6bfaede87aaecd6541";
const BUSYBOX =
  "busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";

const tag = `core-res-e2e-${String(process.pid)}`;
const executors = { w1: `${tag}-w1`, w2: `${tag}-w2` } as const;
const ownNetworks = { w1: `${tag}-w1-net`, w2: `${tag}-w2-net` } as const;

/** Subnets from a /20 this run picks, as Core's table would hand them out. */
const subnetPool = (): ResourceSubnets & { readonly held: ReadonlyMap<string, string> } => {
  const third = 16 * Math.floor(Math.random() * 15);
  const held = new Map<string, string>();
  let next = 0;
  return {
    held,
    allocate: async ({ name }) => {
      const existing = held.get(name);
      if (existing !== undefined) return existing;
      const index = next;
      next += 1;
      const subnet = `10.247.${String(third + Math.floor(index / 8))}.${String((index % 8) * 32)}/27`;
      held.set(name, subnet);
      return subnet;
    },
    release: async (name) => {
      held.delete(name);
    },
  };
};

const record = (uuid: string, spec: ReturnType<typeof postgresSpec>): ResourceInstanceRecord => ({
  ...instanceRecord({ uuid, spec }),
  id: ResourceInstanceId.make(`rin:${uuid}`),
  specDigest: resourceInstanceSpecDigest(spec),
});

describe("resource instances on Docker", () => {
  const subnets = subnetPool();
  const runtime = new DockerResourceRuntime({ subnets, readyTimeoutMs: 90_000 });
  const links = [linkedExecutor(executors.w1, "w1"), linkedExecutor(executors.w2, "w2")];
  // The image declares VOLUME /var/lib/postgresql; the spec names none, so Core must cover it.
  const db = record(
    randomUUID(),
    postgresSpec({ image: POSTGRES, volumes: [], env: { POSTGRES_HOST_AUTH_METHOD: "trust" } }),
  );
  const mail = record(
    randomUUID(),
    postgresSpec({
      alias: "mail",
      worktreeKey: "w1",
      image: REDIS,
      volumes: [{ name: "data", mountPath: "/data" }],
      env: {},
      ready: { kind: "tcp", port: 6379 },
    }),
  );
  const mailProject = record(
    randomUUID(),
    postgresSpec({
      alias: "mail",
      image: REDIS,
      volumes: [{ name: "data", mountPath: "/data" }],
      env: {},
      ready: { kind: "tcp", port: 6379 },
    }),
  );
  const created = { volumes: new Set<string>(), networks: new Set<string>() };
  const up = async (instance: ResourceInstanceRecord) => {
    const result = await runtime.up(instance, desiredAttachments(links, [instance]));
    for (const volume of result.volumes ?? []) {
      created.volumes.add(instanceVolumeName(instance.id, volume.name));
    }
    created.networks.add(egressNetworkName(instance.id));
    return { ...instance, volumes: result.volumes ?? instance.volumes, result };
  };
  const psql = (instance: ResourceInstanceRecord, sql: string) =>
    runtime.exec(
      instance,
      { argv: ["psql", "-U", "postgres", "-tAc", sql], user: "postgres", timeoutMs: 30_000 },
      null,
    );
  /** The executor's addresses on every network it is on. */
  const addresses = async (container: string) =>
    (
      await docker(
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
        container,
      )
    )
      .split(" ")
      .filter((address) => address.length > 0);

  beforeAll(async () => {
    for (const key of ["w1", "w2"] as const) {
      await docker("network", "create", "--label", `core-res-test=${tag}`, ownNetworks[key]);
      await docker(
        "run",
        "-d",
        "--name",
        executors[key],
        "--label",
        `core-res-test=${tag}`,
        "--network",
        ownNetworks[key],
        BUSYBOX,
        "httpd",
        "-f",
        "-p",
        "8080",
      );
      created.networks.add(reachNetworkName(executors[key]));
      await runtime.attachExecutor(executors[key], []);
    }
  }, 120_000);

  afterAll(async () => {
    const containers = [
      executors.w1,
      executors.w2,
      instanceContainerName(db.id),
      instanceContainerName(mail.id),
      instanceContainerName(mailProject.id),
    ];
    // Exactly what this file made: its containers (rm -f without -v), networks and volumes.
    await docker("rm", "-f", ...containers).catch(() => undefined);
    for (const network of [...created.networks, ...Object.values(ownNetworks)]) {
      await docker("network", "rm", network).catch(() => undefined);
    }
    for (const volume of created.volumes) {
      await docker("volume", "rm", volume).catch(() => undefined);
    }
  }, 120_000);

  it("answers one container to up twice, with the image's VOLUME on a named volume", async () => {
    const first = await up(db);
    expect(first.result.state.kind).toBe("running");
    const second = await up(db);
    expect(second.result.state.kind).toBe("running");
    const listed = await docker(
      "ps",
      "-a",
      "--filter",
      `label=sealant.resource-instance=${db.id}`,
      "--format",
      "{{.Names}}",
    );
    expect(listed.split("\n")).toEqual([instanceContainerName(db.id)]);
    expect(first.volumes).toEqual([
      { name: expect.stringMatching(/^img-[0-9a-f]{8}$/), mountPath: "/var/lib/postgresql" },
    ]);
    const mounts = await docker(
      "inspect",
      "--format",
      "{{range .Mounts}}{{.Type}} {{.Name}}\n{{end}}",
      instanceContainerName(db.id),
    );
    expect(mounts.split("\n").map((mount) => mount.split(" "))).toEqual(
      first.volumes.map((volume) => ["volume", instanceVolumeName(db.id, volume.name)]),
    );
  }, 180_000);

  it("lets two linked workspaces reach db by name and never each other", async () => {
    for (const executor of Object.values(executors)) {
      expect(await succeeds("exec", executor, "nc", "-z", "-w", "3", "db", "5432"), executor).toBe(
        true,
      );
    }
    for (const [from, to] of [
      [executors.w1, executors.w2],
      [executors.w2, executors.w1],
    ] as const) {
      expect(await succeeds("exec", to, "nc", "-z", "-w", "2", "127.0.0.1", "8080")).toBe(true);
      for (const address of await addresses(to)) {
        expect(
          await succeeds("exec", from, "nc", "-z", "-w", "2", address, "8080"),
          `${from} -> ${to} at ${address}`,
        ).toBe(false);
      }
      expect(await succeeds("exec", from, "nslookup", to)).toBe(false);
    }
  }, 120_000);

  it("resolves a worktree instance only from its worktree's workspace", async () => {
    const started = await up(mail);
    expect(started.result.state.kind).toBe("running");
    expect(await succeeds("exec", executors.w1, "nc", "-z", "-w", "3", "mail", "6379")).toBe(true);
    expect(await succeeds("exec", executors.w2, "nc", "-z", "-w", "3", "mail", "6379")).toBe(false);
    expect(await succeeds("exec", executors.w2, "nslookup", "mail")).toBe(false);
  }, 180_000);

  it("resolves an alias to the level the link's map names, and flips on the next attach", async () => {
    const started = await up(mailProject);
    expect(started.result.state.kind).toBe("running");
    // ping prints the address the name resolved to first, whether or not the ping is answered.
    const resolved = async () =>
      [
        ...(
          await docker("exec", executors.w1, "sh", "-c", "ping -c 1 -W 1 mail 2>&1 || true")
        ).matchAll(/^PING mail \(([0-9.]+)\)/gm),
      ].map((match) => match[1]);
    const addressOn = async (instance: ResourceInstanceRecord) =>
      docker(
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${reachNetworkName(executors.w1)}").IPAddress}}`,
        instanceContainerName(instance.id),
      );
    const attach = (level: "project" | "worktree") =>
      runtime.attachExecutor(
        executors.w1,
        desiredAttachments(
          [linkedExecutor(executors.w1, "w1", undefined, { db: "project", mail: level })],
          [db, mail, mailProject],
        ),
      );
    const onReach = async () =>
      (
        await docker(
          "network",
          "inspect",
          "--format",
          "{{range .Containers}}{{.Name}} {{end}}",
          reachNetworkName(executors.w1),
        )
      )
        .split(" ")
        .filter((name) => name.startsWith("sealres-"))
        .toSorted();
    await attach("worktree");
    expect(await resolved()).toEqual([await addressOn(mail)]);
    expect(await onReach()).toEqual(
      [instanceContainerName(db.id), instanceContainerName(mail.id)].toSorted(),
    );
    await attach("project");
    expect(await resolved()).toEqual([await addressOn(mailProject)]);
    expect(await onReach()).toEqual(
      [instanceContainerName(db.id), instanceContainerName(mailProject.id)].toSorted(),
    );
    await runtime.attachExecutor(executors.w1, desiredAttachments(links, [db, mail]));
  }, 180_000);

  it("keeps a write through stop and up, and refuses the metadata address after the restart", async () => {
    expect(
      (await psql(db, "create table kept (v text); insert into kept values ('row-1')")).exitCode,
    ).toBe(0);
    await runtime.stop(db);
    expect((await runtime.observe()).get(db.id)?.running).toBe(false);
    const again = await up(db);
    expect(again.result.state.kind).toBe("running");
    expect((await psql(db, "select v from kept")).stdout.trim()).toBe("row-1");
    const routes = await docker("exec", instanceContainerName(db.id), "ip", "route");
    expect(routes).toMatch(/prohibit 169\.254\.169\.254/);
    expect(await succeeds("exec", executors.w1, "nc", "-z", "-w", "3", "db", "5432")).toBe(true);
  }, 180_000);

  it("lands a 50 MB stdin byte for byte, and answers capped tails and timeouts", async () => {
    const blob = randomBytes(50 * 1024 * 1024);
    const chunks = async function* () {
      for (let offset = 0; offset < blob.length; offset += 1024 * 1024) {
        yield blob.subarray(offset, offset + 1024 * 1024);
      }
    };
    const landed = await runtime.exec(
      db,
      {
        argv: ["sh", "-c", "cat > /tmp/blob && sha256sum /tmp/blob && rm /tmp/blob"],
        user: null,
        timeoutMs: 120_000,
      },
      chunks(),
    );
    expect(landed.exitCode).toBe(0);
    expect(landed.stdout.split(" ")[0]).toBe(createHash("sha256").update(blob).digest("hex"));
    const long = await runtime.exec(
      db,
      {
        argv: ["sh", "-c", "head -c 3000000 /dev/zero | tr '\\0' x"],
        user: null,
        timeoutMs: 30_000,
      },
      null,
    );
    expect(long.stdout.length).toBe(1024 * 1024);
    expect(long.truncated).toBe(true);
    const slow = await runtime.exec(
      db,
      { argv: ["sleep", "30"], user: null, timeoutMs: 1000 },
      null,
    );
    expect(slow).toMatchObject({ timedOut: true, exitCode: null });
  }, 180_000);

  it("removes an executor's reach network and its subnet when it detaches", async () => {
    await runtime.detachExecutor(executors.w2);
    expect(await succeeds("network", "inspect", reachNetworkName(executors.w2))).toBe(false);
    expect(subnets.held.has(reachNetworkName(executors.w2))).toBe(false);
    expect(await succeeds("exec", executors.w2, "nslookup", "db")).toBe(false);
    expect(await succeeds("exec", executors.w1, "nc", "-z", "-w", "3", "db", "5432")).toBe(true);
  }, 60_000);

  it("archives an instance: its container goes, every volume stays and is measured", async () => {
    const current = { ...db, volumes: (await up(db)).volumes };
    const volumes = await runtime.archive(current);
    expect(await succeeds("container", "inspect", instanceContainerName(db.id))).toBe(false);
    expect(await succeeds("network", "inspect", egressNetworkName(db.id))).toBe(false);
    expect(volumes).toHaveLength(1);
    for (const volume of volumes) {
      expect(await succeeds("volume", "inspect", volume.dockerName)).toBe(true);
      expect(volume.bytes).toBeGreaterThan(1_000_000);
    }
    const restored = await up({ ...db, volumes: current.volumes });
    expect(restored.result.state.kind).toBe("running");
    expect((await psql(db, "select v from kept")).stdout.trim()).toBe("row-1");
  }, 240_000);
});
