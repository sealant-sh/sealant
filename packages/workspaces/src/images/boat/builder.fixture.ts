import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect } from "vitest";

import { createWorkspaceBuildSpec } from "../../buildkit/docker-parity.fixture.js";
import { HttpBoatApi, type BoatApi } from "../../runtime/boat/api.js";
import { BoatSecret } from "../../runtime/boat/config.js";
import { BoatSnapshotBuilder } from "./builder.js";
import { VerifiedRuntimeBundle } from "./runtime-bundle.js";

const directory = process.env.SEALANT_BOAT_RUNTIME_BUNDLE;
const assertNonemptyBundleBytes: BoatApi["uploadFile"] = async (_id, _path, bytes) => {
  expect(bytes.length).toBeGreaterThan(0);
  return { ok: true, value: undefined };
};
const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of resources.splice(0).toReversed()) await stop();
});
export const nativeBuilderProbe = {
  version: 1,
  tools: {
    sudo: true,
    sudoSetuid: true,
    useradd: true,
    groupadd: true,
    setfacl: true,
    getfacl: true,
    setpriv: true,
    flock: true,
  },
  sudoersMend: true,
  sudoersIncludesDir: true,
  noNewPrivileges: false,
  passwdWritable: true,
  mendGroup: "present",
  reservedIdsInUse: [],
  personEnv: true,
  sharedDirs: [],
  gitTrustsWorktree: true,
  sealantd: { schemaVersion: 1, supports: ["exec.user", "dotfiles.user", "restore.owner_map"] },
};

export const nativeBuilderFixture = async (
  mode: "normal" | "lost-save" | "failed-save" | "cancel" | "cancel-cleaning",
) => {
  if (!directory) throw new Error("exact runtime bundle required");
  const bundle = VerifiedRuntimeBundle.parse({
    sourceIndex: await readFile(join(directory, "source-index.json")),
    platformManifest: await readFile(join(directory, "platform-manifest.json")),
    sealantd: await readFile(join(directory, "sealantd")),
    socat: await readFile(join(directory, "socat")),
    relay: await readFile(join(directory, "control-relay.cjs")),
  });
  if (!bundle.ok) throw bundle.error;
  const root = await mkdtemp(join(tmpdir(), "boat-builder-http-"));
  resources.push(async () => {
    await readdir(root);
    await rm(root, { recursive: true, force: true });
  });
  const id = "bx_23456789",
    deletion = "bdop_" + "a".repeat(32);
  const mutations: string[] = [];
  let allocationLabels: Record<string, string> = {};
  let marker = "",
    snapshot: { name: string; sourceSandboxId: string; createdAt: string } | undefined;
  let savedPosts = 0,
    deleted = false,
    polls = 0;
  const cancellation = new AbortController();
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (b: Buffer) => chunks.push(b));
    request.on("end", () => {
      const body: unknown = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      const respond = (value: unknown, status = 200) =>
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(value));
      const path = request.url ?? "";
      if (request.method !== "GET") mutations.push(request.method + " " + path);
      if (path.startsWith("/api/v1/sandboxes?") && request.method === "GET") {
        respond({
          ok: true,
          sandboxes: marker && !deleted ? [{ id, state: "ready", labels: allocationLabels }] : [],
          pageInfo: { hasMore: false, nextCursor: null, limit: 200 },
        });
      } else if (path === "/api/v1/sandboxes" && request.method === "POST") {
        expect(body).toMatchObject({
          ttlSeconds: 900,
          noEnv: true,
          monitoring: false,
          snapshots: true,
          visibility: "private",
        });
        if (typeof body !== "object" || body === null || !("labels" in body))
          throw new Error("missing allocation labels");
        const labels = body.labels;
        if (
          typeof labels !== "object" ||
          labels === null ||
          !("sealant-build" in labels) ||
          typeof labels["sealant-build"] !== "string"
        )
          throw new Error("missing build");
        marker = labels["sealant-build"];
        allocationLabels = Object.fromEntries(
          Object.entries(labels).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
        respond({ ok: true, sandbox: { id, state: "ready" } });
      } else if (path === "/api/v1/sandboxes/" + id && request.method === "GET") {
        respond({
          ok: true,
          sandbox: {
            id,
            state: "ready",
            labels: allocationLabels,
          },
        });
      } else if (path.endsWith("/commands")) {
        if (
          typeof body !== "object" ||
          body === null ||
          !("command" in body) ||
          typeof body.command !== "string"
        )
          throw new Error("invalid command");
        if (mode === "cancel" && body.command.includes("sudo /bin/bash")) {
          cancellation.abort();
          return;
        }
        respond({
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout:
            body.command === "set -eu\n/usr/bin/sudo cat /etc/sealant/image-probe.json"
              ? JSON.stringify(nativeBuilderProbe)
              : "",
          stderr: "",
        });
      } else if (path.endsWith("/files")) respond({ ok: true });
      else if (path === "/api/v1/saved-snapshots" && request.method === "POST") {
        savedPosts++;
        if (
          typeof body !== "object" ||
          body === null ||
          !("name" in body) ||
          typeof body.name !== "string"
        )
          throw new Error("missing name");
        snapshot = { name: body.name, sourceSandboxId: id, createdAt: new Date().toISOString() };
        if (mode === "lost-save") {
          response.destroy();
          return;
        }
        respond({ ok: true, snapshot: { ...snapshot, status: "saving" } }, 202);
      } else if (path === "/api/v1/sandboxes/" + id && request.method === "DELETE")
        respond({
          ok: true,
          operation: { id: deletion, kind: "sandbox", targetId: id, status: "pending" },
        });
      else if (path === "/api/v1/deletion-operations/" + deletion) {
        if (++polls > 1) deleted = true;
        if (mode === "cancel-cleaning" && deleted) cancellation.abort();
        respond({
          ok: true,
          operation: {
            id: deletion,
            kind: "sandbox",
            targetId: id,
            status: deleted ? "completed" : "processing",
          },
        });
      } else if (path.startsWith("/api/v1/saved-snapshots/")) {
        if (request.method === "DELETE" && snapshot) {
          const name = snapshot.name;
          snapshot = undefined;
          respond({ ok: true, name, status: "deleted" });
        } else if (snapshot)
          respond({
            ok: true,
            snapshot: {
              ...snapshot,
              snapshotId: "exact-provider-id",
              status: mode === "failed-save" ? "failed" : "ready",
            },
          });
        else respond({ ok: false, code: "not_found" }, 404);
      } else respond({ ok: false, code: "not_found" }, 404);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  resources.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const secret = BoatSecret.parse("boat_test_credential_0123456789");
  if (!secret.ok) throw secret.error;
  const parsed = HttpBoatApi.create({
    credential: secret.value,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
  });
  if (!parsed.ok) throw parsed.error;
  const api = parsed.value;
  const provider: BoatApi = {
    create: api.create.bind(api),
    discover: api.discover.bind(api),
    get: api.get.bind(api),
    execute: api.execute.bind(api),
    writeFile: api.writeFile.bind(api),
    uploadFile: assertNonemptyBundleBytes,
    hostControl: api.hostControl.bind(api),
    stop: api.stop.bind(api),
    resume: api.resume.bind(api),
    deleteSandbox: api.deleteSandbox.bind(api),
    getDeletion: api.getDeletion.bind(api),
    saveSnapshot: api.saveSnapshot.bind(api),
    getSnapshot: api.getSnapshot.bind(api),
    deleteSnapshot: api.deleteSnapshot.bind(api),
  };
  const builderOwner = randomUUID();
  const builder = new BoatSnapshotBuilder({
    api: provider,
    runtimeBundle: bundle.value,
    journalDirectory: root,
    owner: builderOwner,
    pollIntervalMs: 1,
    cleanupTimeoutMs: 3000,
  });
  const spec = createWorkspaceBuildSpec({
    target: {
      os: { family: "ubuntu", mode: "require" },
      runtime: { family: "auto", mode: "prefer" },
    },
  });
  return {
    builder,
    root,
    owner: builderOwner,
    spec,
    mutations,
    cancellation,
    deleted: () => deleted,
    posts: () => savedPosts,
  };
};
