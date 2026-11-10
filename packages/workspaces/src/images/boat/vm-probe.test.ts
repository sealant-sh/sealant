import { execFile } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const PROBE = fileURLToPath(new URL("../../../boat-image/vm-probe.sh", import.meta.url));

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
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

const targetsOnly = (targets: string): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve) => {
    execFile(
      "bash",
      [PROBE, "--targets-only"],
      { env: { ...process.env, PROBE_TARGETS: targets, PROBE_WHERE: "container" } },
      (error, stdout) => {
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout });
      },
    );
  });

describe("vm-probe.sh output", () => {
  it("prints one PASS or FAIL line per check and a summary that counts them", async () => {
    const open = await listening();
    const shut = await closed();
    const result = await targetsOnly(
      [
        `reachable-target 127.0.0.1 ${String(open)}`,
        `closed-target 127.0.0.1 ${String(shut)}`,
      ].join("\n"),
    );
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      new RegExp(`^FAIL +container +reachable-target +127\\.0\\.0\\.1:${String(open)} answers$`),
    );
    expect(lines[1]).toMatch(
      /^PASS +container +closed-target +127\.0\.0\.1 ports \d+ closed or filtered$/,
    );
    // Every line is a check or the verdict: nothing a reader has to interpret.
    for (const line of lines.slice(0, -1)) expect(line).toMatch(/^(PASS|FAIL|SKIP) /);
    expect(lines.at(-1)).toBe("SUMMARY container pass=1 fail=1");
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
