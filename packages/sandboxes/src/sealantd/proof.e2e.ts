/**
 * End-to-end proof that the baked-in sealantd runtime daemon is reachable and functional inside a
 * real sandbox image built by the BuildKit OS builder (P3-Build).
 *
 * What this exercises, against the actual image (no mocks, no DB/queue/worker):
 *   1. BOOT — `docker run` the image so its PID-1 `sealantd boot` supervisor brings up the
 *      in-process control server on `/run/sealant/control.sock`. We keep the container alive and
 *      skip the git clone without touching the image:
 *        - `SEALANT_FOREGROUND_COMMAND=sleep infinity` overrides the supervised foreground with a
 *          long-lived process (boot honors this run-dynamic override instead of launching the harness).
 *        - A host dir containing a `.git/` marker is bind-mounted at `/sandbox/repo` (the resolved
 *          `workingDirectory`), satisfying the entrypoint's `[ ! -d "$WORKING_DIRECTORY/.git" ]`
 *          guard so the real clone is skipped. No network, no real repo.
 *   2. BRIDGE — `docker exec -i <ctr> socat - UNIX-CONNECT:/run/sealant/control.sock`. The child's
 *      stdio is a Node Duplex carrying the length-prefixed protobuf control frames. We deliberately
 *      DO NOT pass `-t`: a PTY would mangle the binary framing.
 *   3. PEER-CRED — sealantd validates the connecting peer via `SO_PEERCRED` on Linux and fails
 *      closed otherwise (crates/sealant-control/src/peer.rs: `peer_allowed`). Root (uid 0) is
 *      ALWAYS allowed, and `docker exec` defaults to root while the entrypoint also runs sealantd as
 *      root — so the bridge's uid matches the daemon's uid AND is root. No `--user` / allowlist
 *      flag is needed.
 *   4. CONTROL + EXEC — `SealantClient.fromStream(duplex)` drives the same request/response/event
 *      machinery as a native socket connection. We assert a healthy control channel, then run
 *      `/bin/echo hi` and assert the telemetry event stream: a `processStarted`, an `ioChunk` on
 *      STDOUT whose bytes decode to `"hi\n"`, and a `processExited` with `exitCode === 0`.
 *
 * This test requires Docker and the prebuilt image; it is intentionally excluded from the default
 * unit run (`*.test.ts`) and runs via `pnpm --filter @sealant/sandboxes test:e2e`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";

import { SealantClient, StreamKind, RuntimeState } from "@sealant/runtime-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Image produced by the P3-Build phase (Fedora + sealantd baked in). */
const IMAGE_REF = "sealant-sandbox-fedora-claude-code:claude-code";
/** Control socket path `sealantd boot` serves on (matches SEALANT_CONTROL_SOCKET in the builder). */
const CONTROL_SOCKET = "/run/sealant/control.sock";
/** Resolved `workingDirectory` default; the entrypoint checks `<this>/.git` to decide whether to clone. */
const WORKING_DIRECTORY = "/sandbox/repo";

/** Run `docker <args>`, resolving with trimmed stdout or rejecting with stderr. */
const docker = (args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`docker ${args.join(" ")} exited ${code ?? "?"}: ${stderr.trim()}`));
      }
    });
  });

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("sealantd baked-image e2e proof", () => {
  let containerId: string | undefined;
  let workspaceMount: string | undefined;
  let bridge: ChildProcessWithoutNullStreams | undefined;
  let client: SealantClient | undefined;
  let transport: Duplex | undefined;

  beforeAll(async () => {
    // A host dir with a `.git/` marker; bind-mounted at /sandbox/repo to skip the entrypoint clone.
    workspaceMount = mkdtempSync(join(tmpdir(), "sealantd-e2e-"));
    mkdirSync(join(workspaceMount, ".git"));

    // Boot the container via the REAL entrypoint: sealantd launches in the background, then the
    // foreground `sleep infinity` (via SEALANT_FOREGROUND_COMMAND) keeps the container alive.
    containerId = await docker([
      "run",
      "-d",
      "--rm",
      // `sealantd boot` requires the repo url/ref env even when the clone is skipped via the `.git`
      // bind mount below. Supply placeholders so config validation passes (no network is touched).
      "-e",
      "SEALANT_SANDBOX_REPO_URL=https://example.invalid/skipped.git",
      "-e",
      "SEALANT_SANDBOX_REPO_REF=main",
      "-e",
      "SEALANT_FOREGROUND_COMMAND=sleep infinity",
      "-v",
      `${workspaceMount}:${WORKING_DIRECTORY}`,
      IMAGE_REF,
    ]);

    // Wait for sealantd to create the control socket (entrypoint runs clone-skip + launch first).
    let socketReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await docker(["exec", containerId, "test", "-S", CONTROL_SOCKET]);
        socketReady = true;
        break;
      } catch {
        await delay(100);
      }
    }
    if (!socketReady) {
      const logs = await docker(["logs", containerId]).catch(() => "(no logs)");
      throw new Error(`sealantd control socket never appeared. Entrypoint logs:\n${logs}`);
    }

    // BRIDGE: docker exec -i (NO -t) + socat relays the control socket over the child's stdio.
    // Peer-cred: `docker exec` runs as root (uid 0), which sealantd always allows.
    bridge = spawn(
      "docker",
      ["exec", "-i", containerId, "socat", "-", `UNIX-CONNECT:${CONTROL_SOCKET}`],
      { stdio: ["pipe", "pipe", "pipe"] },
    ) as ChildProcessWithoutNullStreams;

    // Adapt the child's (readable stdout, writable stdin) into a single Duplex transport.
    transport = Duplex.from({ readable: bridge.stdout, writable: bridge.stdin });
    client = SealantClient.fromStream(transport);
  }, 60_000);

  afterAll(async () => {
    transport?.destroy();
    bridge?.kill("SIGKILL");
    if (containerId) {
      await docker(["rm", "-f", containerId]).catch(() => {});
    }
    if (workspaceMount) {
      rmSync(workspaceMount, { recursive: true, force: true });
    }
  });

  it("reports a healthy control channel over the docker-exec/socat bridge", async () => {
    expect(client).toBeDefined();
    const health = await client!.health();
    // RUNTIME_STATE_HEALTHY (2) proves the daemon booted and the control channel round-trips.
    expect(health.state).toBe(RuntimeState.HEALTHY);
    expect(health.runtimeId).toMatch(/^rt_/);
  }, 30_000);

  it("executes /bin/echo and streams processStarted + STDOUT 'hi\\n' + processExited(0)", async () => {
    expect(client).toBeDefined();

    const accepted = await client!.exec({
      executable: "/bin/echo",
      args: ["hi"],
      stdin: false,
    });
    expect(accepted.processId).toMatch(/^proc_/);

    let sawProcessStarted = false;
    let stdout = "";
    let exitCode: number | undefined;

    const deadline = Date.now() + 15_000;
    for await (const event of client!.events()) {
      // Correlate to our exec; other lifecycle events should not be present, but be defensive.
      if (event.processId !== undefined && event.processId !== accepted.processId) {
        continue;
      }
      const payload = event.payload;
      if (payload.case === "processStarted") {
        sawProcessStarted = true;
      } else if (
        payload.case === "ioChunk" &&
        payload.value.stream === StreamKind.STDOUT &&
        payload.value.content !== undefined
      ) {
        stdout += Buffer.from(payload.value.content).toString("utf8");
      } else if (payload.case === "processExited") {
        exitCode = payload.value.exitCode;
        break;
      }
      if (Date.now() > deadline) {
        break;
      }
    }

    expect(sawProcessStarted).toBe(true);
    expect(stdout).toBe("hi\n");
    expect(exitCode).toBe(0);
  }, 30_000);
});
