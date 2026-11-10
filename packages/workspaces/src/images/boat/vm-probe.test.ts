import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile, chmod } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const PROBE = fileURLToPath(new URL("../../../boat-image/vm-probe.sh", import.meta.url));

const servers: net.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A local listener the probe will find reachable. */
const listening = async (): Promise<number> => {
  const server = net.createServer((socket) => socket.destroy());
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  return address.port;
};

/** A port nothing listens on: bound once, then released. */
const closed = async (): Promise<number> => {
  const port = await listening();
  await new Promise<void>((done) => servers.pop()?.close(() => done()));
  return port;
};

/** Where a binary lives on this host, so a PATH can carry it alone. */
const which = (tool: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("sh", ["-c", `command -v ${tool}`], (error, stdout) => {
      if (error === null) resolve(stdout.trim());
      else reject(error);
    });
  });

/** A PATH with exactly these tools (and any fakes written into it). */
const toolbox = async (tools: readonly string[], fakes: Record<string, string> = {}) => {
  const dir = await mkdtemp(path.join(tmpdir(), "vm-probe-path-"));
  dirs.push(dir);
  for (const tool of tools) await symlink(await which(tool), path.join(dir, tool));
  for (const [name, script] of Object.entries(fakes)) {
    await writeFile(path.join(dir, name), script);
    await chmod(path.join(dir, name), 0o755);
  }
  return dir;
};

const probe = (
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number; lines: string[] }> =>
  new Promise((resolve) => {
    execFile(
      "bash",
      [PROBE, ...args],
      { env: { ...process.env, ...env }, timeout: 60_000 },
      (error, stdout) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          lines: stdout.trim().split("\n"),
        });
      },
    );
  });

const checks = (lines: readonly string[]) =>
  lines.filter((line) => /^(PASS|FAIL|SKIP) /.test(line));

describe("vm-probe.sh output", () => {
  it("passes only a refused connection, fails one that answers, and never passes a probe error", async () => {
    const open = await listening();
    const shut = await closed();
    const { code, lines } = await probe(["--targets-only"], {
      PROBE_WHERE: "container",
      PROBE_TARGETS: [
        `reachable-target 127.0.0.1 ${String(open)}`,
        `closed-target 127.0.0.1 ${String(shut)}`,
        "bad-address not-an-address 80",
      ].join("\n"),
    });
    expect(code).toBe(0);
    expect(checks(lines)).toEqual([
      expect.stringMatching(
        new RegExp(`^FAIL +container +reachable-target +127\\.0\\.0\\.1:${String(open)} answers$`),
      ),
      expect.stringMatching(
        new RegExp(`^PASS +container +closed-target +127\\.0\\.0\\.1 ${String(shut)}:closed$`),
      ),
      expect.stringMatching(
        /^FAIL +container +bad-address +probe error: 'not-an-address' is not an IP address$/,
      ),
    ]);
    expect(lines.at(-1)).toBe("SUMMARY container pass=1 fail=2 skip=0 result=FAIL");
  });

  it("fails, and passes nothing, when it cannot bound a connection attempt (no timeout)", async () => {
    const shut = await closed();
    const binDir = await toolbox(["bash"]);
    const { lines } = await probe(["--targets-only"], {
      PROBE_PATH: binDir,
      PROBE_WHERE: "container",
      PROBE_TARGETS: `closed-target 127.0.0.1 ${String(shut)}`,
    });
    expect(checks(lines)).toEqual([
      expect.stringMatching(/^FAIL +container +prerequisite-timeout +missing/),
    ]);
    expect(lines.at(-1)).toBe("SUMMARY container pass=0 fail=1 skip=0 result=FAIL");
  });

  it("names every check it could not make without ip, and never reads as all-pass", async () => {
    const binDir = await toolbox(["bash", "timeout", "awk", "head", "tr", "id"]);
    const { lines } = await probe(["--isolation-only"], { PROBE_PATH: binDir });
    for (const check of [
      "default-gateway",
      "provider-wg0-peer",
      "provider-subnet-host",
      "provider-neighbour",
    ]) {
      expect(lines).toContainEqual(
        expect.stringMatching(
          new RegExp(`^SKIP +isolation +${check} +no ip on this VM to discover the target$`),
        ),
      );
    }
    expect(lines.at(-1)).toMatch(
      /^SUMMARY isolation pass=\d+ fail=\d+ skip=4 result=(INCOMPLETE|FAIL)$/,
    );
  }, 90_000);

  it("probes hosts inside each WireGuard peer prefix, and names a prefix too broad to sample", async () => {
    // A provider wg0 whose peer routes a /24 and the whole Internet.
    const binDir = await toolbox(["bash", "timeout", "awk", "head", "tr", "id"], {
      ip: `#!/bin/sh
case "$*" in
  "link show dev wg0") exit 0 ;;
  *"address show dev wg0"*) echo "5: wg0    inet 10.248.0.1/32 scope global wg0" ;;
esac
exit 0
`,
      wg: `#!/bin/sh
printf 'PEERKEY=\\t198.51.100.0/24 0.0.0.0/0\\n'
`,
    });
    const { lines } = await probe(["--isolation-only"], { PROBE_PATH: binDir });
    const wireguard = lines.filter((line) => line.includes("provider-wg0-peer"));
    // In the order wg lists the prefixes: two hosts of the /24, then the /0 named as not covered.
    expect(wireguard).toEqual([
      expect.stringMatching(/^(PASS|FAIL) +isolation +provider-wg0-peer +198\.51\.100\.1[ :]/),
      expect.stringMatching(/^(PASS|FAIL) +isolation +provider-wg0-peer +198\.51\.100\.2[ :]/),
      expect.stringMatching(
        /^SKIP +isolation +provider-wg0-peer +0\.0\.0\.0\/0 prefix \/0 too broad to sample$/,
      ),
    ]);
    // The network address itself is never what is probed.
    expect(lines.some((line) => line.includes("198.51.100.0 "))).toBe(false);
    expect(lines.at(-1)).toMatch(/result=(INCOMPLETE|FAIL)$/);
  }, 90_000);

  it("chooses hosts inside a prefix: the /32 itself, both of a /31, else the first two", async () => {
    const cases: Array<[string, string]> = [
      ["198.51.100.0/24", "198.51.100.1 198.51.100.2"],
      ["192.168.1.17/20", "192.168.0.1 192.168.0.2"],
      ["10.0.0.5/32", "10.0.0.5"],
      ["10.0.0.4/31", "10.0.0.4 10.0.0.5"],
      ["0.0.0.0/0", "not-covered prefix /0 too broad to sample"],
      ["fd00::/64", "not-covered not an IPv4 prefix"],
    ];
    for (const [prefix, hosts] of cases) {
      expect((await probe(["--hosts-for", prefix], {})).lines).toEqual([hosts]);
    }
  });

  it("refuses to run the full probe without root, with a usage line", async () => {
    if (process.getuid?.() === 0) return;
    const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile("bash", [PROBE], (error, _stdout, stderr) => {
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stderr });
      });
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("run as root");
  });
});
