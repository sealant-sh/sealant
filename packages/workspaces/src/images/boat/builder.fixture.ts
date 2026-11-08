import { spawn } from "node:child_process";
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
import { sha256, VerifiedRuntimeBundle } from "./runtime-bundle.js";

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

const manifest = JSON.stringify({
  format: "sealant-guest-manifest-v1",
  files: {
    "/var/lib/sealant/guest/bundle/usr/bin/python3": {
      sha256: "a".repeat(64),
      device: 7,
      inode: 9,
      uid: 0,
      gid: 0,
      mode: 493,
    },
  },
  inputs: { policy: "b".repeat(64) },
  bundle_paths: ["/var/lib/sealant/guest/bundle/usr/bin/python3"],
});
const constructionInputs = JSON.stringify({
  format: "sealant-bundle-inputs-v1",
  source_files: {
    "/usr/bin/python3": { sha256: "a".repeat(64), mode: 493 },
  },
  cache_policy: "source-only-zip-no-bytecode",
  stdlib: "/usr/lib/python3.12",
});
const guestEvidence = {
  manifest,
  manifestDigest: sha256(manifest),
  constructionInputs,
  constructionInputsDigest: sha256(constructionInputs),
  approval: {
    format: "sealant-source-profile-approval-v2",
    profile: "sealant-shipped-guest-v1",
    manifest_digest: sha256(manifest),
    policy_digest: "b".repeat(64),
    semantic_checks: "passed-with-shipped-assets",
    semantic_receipt_digest: "d".repeat(64),
    source_boot_id: "faithful-source-boot",
  },
};

export const nativeBuilderFixture = async (
  mode:
    | "normal"
    | "lost-save"
    | "failed-save"
    | "cancel"
    | "cancel-cleaning"
    | "command-failed"
    | "command-timeout"
    | "transport-failed"
    | "provider-http-failed"
    | "status-http-failed"
    | "legacy-guest-approval",
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
  const snapshots = new Map<string, NonNullable<typeof snapshot>>();
  let savedPosts = 0,
    deleted = false,
    polls = 0,
    removalFailures = 0;
  let detachedOutput = { exitCode: 0, stdout: "", stderr: "" };
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
        deleted = false;
        polls = 0;
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
      } else if (path.includes("/commands/1234")) {
        if (request.method === "DELETE")
          respond({ ok: true, processId: 1234, running: false, signaled: true });
        else if (mode === "status-http-failed")
          respond({ code: "provider_error", message: "Bearer private-token" }, 503);
        else
          respond({
            ok: true,
            processId: 1234,
            status: "exited",
            running: false,
            ...detachedOutput,
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
        if (body.command.includes("sudo /bin/bash")) {
          if (mode === "transport-failed") {
            response.destroy();
            return;
          }
          if (mode === "provider-http-failed") {
            respond({ code: "provider_error", message: "Bearer private-token" }, 503);
            return;
          }
        }
        if (mode === "command-timeout" && body.command.includes("install -d -m700")) {
          respond({
            ok: true,
            exitCode: null,
            timedOut: true,
            stdout: "installer progress\n",
            stderr: "installer refused package\n",
          });
          return;
        }
        if ("detached" in body && body.detached === true) {
          detachedOutput =
            mode === "command-failed"
              ? {
                  exitCode: 42,
                  stdout: "installer progress\n",
                  stderr:
                    "installer refused package\nAuthorization: Bearer fixture-private-token\nhttps://user:password@example.invalid/install?token=secret\n",
                }
              : { exitCode: 0, stdout: "", stderr: "" };
          respond({ ok: true, processId: 1234 });
          return;
        }
        respond({
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout:
            body.command ===
            "set -eu\n/usr/bin/sudo cat /var/lib/sealant/workspace-root/etc/sealant/image-probe.json"
              ? JSON.stringify(nativeBuilderProbe)
              : body.command.includes("constructionInputsDigest")
                ? JSON.stringify(
                    mode === "legacy-guest-approval"
                      ? {
                          ...guestEvidence,
                          approval: {
                            ...guestEvidence.approval,
                            format: "sealant-source-profile-approval-v1",
                            profile: "clean-installed-255.4-1ubuntu8.18",
                          },
                        }
                      : guestEvidence,
                  )
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
        snapshots.set(snapshot.name, snapshot);
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
        snapshot = snapshots.get(decodeURIComponent(path.slice("/api/v1/saved-snapshots/".length)));
        if (request.method === "DELETE" && snapshot) {
          if (removalFailures > 0) {
            removalFailures--;
            respond({ ok: false, code: "temporarily_unavailable" }, 503);
            return;
          }
          const name = snapshot.name;
          snapshots.delete(name);
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
    api: provider,
    bundle: bundle.value,
    root,
    owner: builderOwner,
    spec,
    mutations,
    cancellation,
    deleted: () => deleted,
    posts: () => savedPosts,
    failSnapshotRemoval: () => {
      removalFailures++;
    },
    replaceSnapshot: (name: string) =>
      snapshots.set(name, {
        name,
        sourceSandboxId: "bx_3456789a",
        createdAt: new Date(0).toISOString(),
      }),
    holdAttempt: async (buildId: string) => {
      const child = spawn(
        "flock",
        [
          "-n",
          join(root, buildId + ".json.lock"),
          "sh",
          "-c",
          "printf 'locked\\n'; cat >/dev/null",
        ],
        { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"] },
      );
      const exited = new Promise<void>((done) => child.once("close", () => done()));
      const release = async () => {
        child.stdin.end();
        await exited;
      };
      resources.push(release);
      await new Promise<void>((done, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error("fixture lock failed")));
        child.stdout.once("data", () => done());
      });
      return release;
    },
  };
};
