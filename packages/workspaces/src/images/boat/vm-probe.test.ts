import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const PROBE = fileURLToPath(new URL("../../../boat-image/vm-probe.sh", import.meta.url));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Where a binary lives on this host, so a PATH can carry it alone. */
const which = (tool: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("sh", ["-c", `command -v ${tool}`], (error, stdout) => {
      if (error === null) resolve(stdout.trim());
      else reject(error);
    });
  });

/** The host tools the probe's own plumbing uses, real ones. */
const PLUMBING = ["bash", "sh", "mkdir", "ls", "rm", "grep", "cat", "tail", "uname"] as const;

/**
 * A VM as the probe sees it: a PATH with exactly the plumbing and these fakes, where the probe is
 * root. Each fake logs its name and arguments, so a test reads what the probe ran. `ok` fakes exit
 * 0, `failing` ones exit 1, and `scripts` are written as given.
 */
const fakeVm = async (
  input: {
    readonly ok?: readonly string[];
    readonly failing?: readonly string[];
    readonly scripts?: Record<string, string>;
  } = {},
) => {
  const dir = await mkdtemp(path.join(tmpdir(), "vm-probe-path-"));
  dirs.push(dir);
  const log = path.join(dir, "ran.log");
  for (const tool of PLUMBING) await symlink(await which(tool), path.join(dir, tool));
  const logged = (rest: string) =>
    `#!/bin/sh\nprintf '%s %s\\n' "\${0##*/}" "$*" >> ${JSON.stringify(log)}\n${rest}\n`;
  const scripts: Record<string, string> = {
    // Root, and a scratch directory where the real probe makes one on the VM's disk.
    id: "#!/bin/sh\necho 0\n",
    mktemp: `#!/bin/sh\nmkdir -p ${JSON.stringify(path.join(dir, "probe-dir"))} && echo ${JSON.stringify(path.join(dir, "probe-dir"))}\n`,
    ...Object.fromEntries((input.ok ?? []).map((tool) => [tool, logged("exit 0")])),
    ...Object.fromEntries((input.failing ?? []).map((tool) => [tool, logged("exit 1")])),
    ...Object.fromEntries(
      Object.entries(input.scripts ?? {}).map(([tool, script]) => [tool, logged(script)]),
    ),
  };
  for (const [name, script] of Object.entries(scripts)) {
    await writeFile(path.join(dir, name), script);
    await chmod(path.join(dir, name), 0o755);
  }
  return {
    path: dir,
    ran: async () =>
      (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== ""),
  };
};

/** Every tool a kernel pass uses, each answering as a VM that can run Docker does. */
const DOCKER_READY = {
  ok: ["mount", "umount", "ip", "iptables", "modprobe", "unshare"],
  scripts: { curl: "printf 401" },
} as const;

const probe = (
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number; lines: string[]; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      "bash",
      [PROBE, ...args],
      { env: { ...process.env, ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          lines: stdout.trim().split("\n"),
          stderr,
        });
      },
    );
  });

const checks = (lines: readonly string[], section: string) =>
  lines.filter((line) => new RegExp(`^(PASS|FAIL|SKIP) +${section} `).test(line));
const check = (lines: readonly string[], name: string) =>
  lines.find((line) => new RegExp(`^(PASS|FAIL|SKIP) +\\S+ +${name} `).test(line));

describe("vm-probe.sh output", () => {
  it("checks what a root dockerd needs of the kernel, and nothing on the provider's network", async () => {
    const vm = await fakeVm(DOCKER_READY);
    const { lines } = await probe([], { PROBE_PATH: vm.path });
    for (const name of ["overlayfs", "bridge", "veth", "iptables-nat", "netns", "docker-hub"])
      expect(check(lines, name), name).toMatch(/^PASS +kernel /);
    // The kernel is the only section: no isolation check is made, printed or counted.
    expect(lines.filter((line) => /^(PASS|FAIL|SKIP|INFO) /.test(line))).toEqual(
      lines.filter((line) => /^(PASS|FAIL|SKIP|INFO) +kernel /.test(line)),
    );
    expect(lines.at(-1)).toMatch(/^SUMMARY kernel pass=\d+ fail=\d+ skip=0 result=(PASS|FAIL)$/);
    expect(lines.join("\n")).not.toMatch(/isolation|metadata|gateway|neighbour|wg0/);
    // What it ran: kernel objects it made and removed, each under a sealant-probe name, and the
    // one request an image pull needs. No address of the provider's is looked up or connected to.
    const ran = await vm.ran();
    expect(ran).toContain("ip link add sealant-probe0 type bridge");
    expect(ran).toContain("ip link delete sealant-probe0");
    expect(ran).toContain("ip netns delete sealant-probe");
    expect(ran).toContain("iptables -t nat -X SEALANT-PROBE");
    expect(ran.filter((line) => line.startsWith("ip "))).toEqual(
      ran.filter((line) => /^ip (link|netns) (add|delete) sealant-probe/.test(line)),
    );
    expect(ran.filter((line) => line.startsWith("curl "))).toEqual([
      "curl -s -o /dev/null -w %{http_code} --max-time 10 https://registry-1.docker.io/v2/",
    ]);
  });

  it("fails, with exit status 1, when the kernel cannot do what Docker needs", async () => {
    const vm = await fakeVm({
      ...DOCKER_READY,
      ok: ["mount", "umount", "iptables"],
      failing: ["ip"],
    });
    const { code, lines } = await probe([], { PROBE_PATH: vm.path });
    for (const name of ["bridge", "veth", "netns"])
      expect(check(lines, name), name).toMatch(/^FAIL +kernel /);
    expect(check(lines, "overlayfs")).toMatch(/^PASS +kernel /);
    expect(lines.at(-1)).toMatch(/^SUMMARY kernel pass=\d+ fail=\d+ skip=0 result=FAIL$/);
    expect(code).toBe(1);
  });

  it("names a check it could not make for want of a tool, which is no kernel gap", async () => {
    // No `ip`, no `curl`: the checks that need them are skipped by name.
    const vm = await fakeVm({ ok: ["mount", "umount", "iptables"] });
    const { lines } = await probe([], { PROBE_PATH: vm.path });
    for (const name of ["bridge", "veth", "netns"])
      expect(check(lines, name), name).toMatch(/^SKIP +kernel +\S+ +no ip on this VM$/);
    expect(check(lines, "docker-hub")).toMatch(/^SKIP +kernel +docker-hub +no curl on this VM$/);
    // A kernel SKIP never makes the verdict INCOMPLETE.
    expect(lines.at(-1)).toMatch(/^SUMMARY kernel pass=\d+ fail=\d+ skip=4 result=(PASS|FAIL)$/);
  });

  it("runs one container with the VM's own Docker when asked, and reports whether it ran", async () => {
    const ran = await fakeVm({ ...DOCKER_READY, ok: [...DOCKER_READY.ok, "docker"] });
    const passed = await probe(["--container", "ubuntu:24.04"], { PROBE_PATH: ran.path });
    expect(checks(passed.lines, "container")).toEqual([
      expect.stringMatching(/^PASS +container +run +ubuntu:24\.04 ran and exited 0$/),
    ]);
    expect(passed.lines.at(-1)).toMatch(
      /^SUMMARY kernel pass=\d+ fail=\d+ skip=0 container pass=1 fail=0 skip=0 result=(PASS|FAIL)$/,
    );
    // On Docker's default bridge network, labelled as the probe's, and removed when it exits.
    expect((await ran.ran()).filter((line) => line.startsWith("docker "))).toEqual([
      "docker run --rm --label sealant-probe=vm-probe ubuntu:24.04 true",
    ]);

    const broken = await fakeVm({
      ...DOCKER_READY,
      scripts: {
        ...DOCKER_READY.scripts,
        docker: "echo 'Unable to find image'; echo 'docker: no bridge' >&2; exit 125",
      },
    });
    const failed = await probe(["--container", "ubuntu:24.04"], { PROBE_PATH: broken.path });
    expect(checks(failed.lines, "container")).toEqual([
      expect.stringMatching(/^FAIL +container +run +docker run exited 125: docker: no bridge$/),
    ]);
    expect(failed.lines.at(-1)).toMatch(/container pass=0 fail=1 skip=0 result=FAIL$/);
    expect(failed.code).toBe(1);

    // No Docker on the VM: the check asked for was not made, and the verdict says so.
    const bare = await fakeVm(DOCKER_READY);
    const skipped = await probe(["--container", "ubuntu:24.04"], { PROBE_PATH: bare.path });
    expect(checks(skipped.lines, "container")).toEqual([
      expect.stringMatching(/^SKIP +container +run +no docker on this VM$/),
    ]);
    expect(skipped.lines.at(-1)).toMatch(
      /container pass=0 fail=0 skip=1 result=(INCOMPLETE|FAIL)$/,
    );
    // Without the flag no container is run and none is counted.
    const plain = await probe([], { PROBE_PATH: ran.path });
    expect(checks(plain.lines, "container")).toEqual([]);
    expect(plain.lines.at(-1)).not.toContain("container");
  });

  it.each([
    ["--isolation-only"],
    ["--targets-only"],
    ["--hosts-for", "198.51.100.0/24"],
    ["--host-network-container", "ubuntu:24.04"],
  ])(
    "has no isolation mode: %s is refused with the usage line, and nothing runs",
    async (...args) => {
      const vm = await fakeVm(DOCKER_READY);
      const { code, lines, stderr } = await probe(args, { PROBE_PATH: vm.path });
      expect(code).toBe(2);
      expect(stderr.trim()).toBe("usage: vm-probe.sh [--container IMAGE]");
      expect(lines).toEqual([""]);
      expect(await vm.ran()).toEqual([]);
    },
  );

  it("refuses to run without root, with a usage line", async () => {
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
