/**
 * Finalizing an interactive run records what the session changed without touching the user's
 * git state: the repository's index keeps its exact bytes (it used to be restaged by
 * `git add -A`). The capture runs for real in a temporary repository; the control plane is a
 * local HTTP server that records the PATCH.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { finalizeInteractiveRun } from "./run-recorder.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((step) => step()));
});

describe("finalizeInteractiveRun", () => {
  it("records the session's changes and leaves the repository's index byte-identical", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sealant-recorder-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.test");
    git(dir, "config", "user.name", "t");
    await writeFile(path.join(dir, "a.txt"), "one\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    // Edited and new, neither staged: the user's choice.
    await writeFile(path.join(dir, "a.txt"), "one edited\n");
    await writeFile(path.join(dir, "new.txt"), "new\n");
    const indexBefore = await readFile(path.join(dir, ".git", "index"));

    const bodies: unknown[] = [];
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;

    await finalizeInteractiveRun({
      config: { apiBaseUrl: `http://127.0.0.1:${String(port)}`, gatewayToken: "t" },
      runId: "run_1",
      ownerUserId: "user_1",
      // The gateway runs the command in the workspace repo; here that is the temp repository.
      captureOutput: async (command) => ({
        output: execFileSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" }),
        exitCode: 0,
      }),
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      status: "completed",
      diff: expect.stringContaining("+one edited"),
      changedFiles: expect.arrayContaining([
        expect.objectContaining({ path: "a.txt", change: "modified" }),
        expect.objectContaining({ path: "new.txt", change: "added" }),
      ]),
    });
    expect((await readFile(path.join(dir, ".git", "index"))).equals(indexBefore)).toBe(true);
    expect(git(dir, "status", "--porcelain").split("\n").filter(Boolean).toSorted()).toEqual([
      " M a.txt",
      "?? new.txt",
    ]);
  });

  it("records a reading that found nothing as read and empty, not as unread", async () => {
    const { bodies, apiBaseUrl } = await recordingApi();
    await finalizeInteractiveRun({
      config: { apiBaseUrl, gatewayToken: "t" },
      runId: "run_1",
      ownerUserId: "user_1",
      captureOutput: async () => ({ output: "\0sealant-name-status\0", exitCode: 0 }),
    });
    expect(bodies).toEqual([
      expect.objectContaining({ status: "completed", diff: "", changedFiles: [] }),
    ]);
  });

  it("records a reading that exited nonzero, or could not run, as failed, with no changes", async () => {
    for (const captureOutput of [
      async () => ({ output: "partial diff\0sealant-name-status\0", exitCode: 1 }),
      async () => {
        throw new Error("control connection closed");
      },
    ]) {
      const { bodies, apiBaseUrl } = await recordingApi();
      await finalizeInteractiveRun({
        config: { apiBaseUrl, gatewayToken: "t" },
        runId: "run_1",
        ownerUserId: "user_1",
        captureOutput,
      });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ status: "completed", changesReadFailed: true });
      expect(bodies[0]).not.toHaveProperty("diff");
      expect(bodies[0]).not.toHaveProperty("changedFiles");
    }
  });
});

/** A stand-in Core API that keeps every request body it was sent. */
const recordingApi = async () => {
  const bodies: unknown[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { bodies, apiBaseUrl: `http://127.0.0.1:${String(port)}` };
};
