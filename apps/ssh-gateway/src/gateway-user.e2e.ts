/**
 * A workspace's SSH sessions as its user (Mend ADR 0016: VS Code Remote-SSH runs as the launcher's
 * Linux user), end to end: OpenSSH's own client, this gateway, and a real daemon in a per-person
 * image. Only the API is a stand-in (an HTTP server answering the two routes the gateway calls,
 * with the owner rule the real one applies).
 *
 * 1. The owner's `ssh` lands as the workspace's user: `id -un`, `$HOME` from passwd, the home 0700
 *    and theirs; in a PTY shell too.
 * 2. What VS Code Remote-SSH's bootstrap does (`ssh -T host bash` with a script on stdin): it
 *    installs a server under `~/.vscode-server`, owned by the user, starts it listening on
 *    loopback, and the client reaches it through a forwarded port (`-L`, direct-tcpip).
 * 3. Another person's key is refused: the API admits only the workspace's owner.
 * 4. A workspace without a user runs as root, as before.
 * 5. SFTP is refused for a workspace with a user (the pinned sealantd runs it only as root).
 *
 * Needs Docker, OpenSSH's `ssh`, `ssh-keygen` and `sftp`, and a managed per-person image whose
 * sealantd reports `exec.user`: `SEALANT_PROCESS_USER_E2E_IMAGE`, default
 * `sealant-workspace-fedora:latest`. Run with:
 *   pnpm --filter @sealant/ssh-gateway test:e2e
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { DockerRuntimeAdapter, parseRuntimeAdapterLaunchInput } from "@sealant/workspaces";
import ssh2 from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startSshGatewayServer } from "./gateway-server.js";

const run = promisify(execFile);

const IMAGE_REF =
  process.env["SEALANT_PROCESS_USER_E2E_IMAGE"] ?? "sealant-workspace-fedora:latest";
const OWNER = "usr_alice";
const OTHER = "usr_bob";
const ALICE = { name: "m4lice000", uid: 40001, home: "/home/m4lice000" };
const BOB = { name: "m8ob0000", uid: 40002, home: "/home/m8ob0000" };
const WORKSPACE_ID = "wks_ssh_user_e2e";
const SERVER_PORT = 47123;

const imageSupports = async (): Promise<readonly string[]> => {
  const out = await run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "sealantd",
    IMAGE_REF,
    "capabilities",
    "--json",
  ]).catch(() => undefined);
  if (out === undefined) return [];
  const parsed: unknown = JSON.parse(out.stdout);
  return typeof parsed === "object" &&
    parsed !== null &&
    "supports" in parsed &&
    Array.isArray(parsed.supports)
    ? parsed.supports.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const runsAsUser = (await imageSupports()).includes("exec.user");
if (!runsAsUser && process.env["SEALANT_E2E_REQUIRE_IMAGE"] === "1") {
  throw new Error(
    `SEALANT_E2E_REQUIRE_IMAGE=1 but ${IMAGE_REF} is missing or its sealantd does not report exec.user.`,
  );
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("no port"));
          return;
        }
        resolve(address.port);
      });
    });
  });

/** The workspace's user as the stand-in API reports it; undefined: none (root). */
let workspaceUser: string | undefined;
let containerId = "";
let gatewayPort = 0;
let api: Server | undefined;
let gateway: { stop: () => Promise<void> } | undefined;
let scratch = "";
const keys = { alice: "", bob: "" };

/** The base64 blob of an OpenSSH public key line, which is what the gateway is offered. */
const keyBlob = async (publicKeyFile: string) =>
  (await readFile(publicKeyFile, "utf8")).trim().split(/\s+/)[1] ?? "";

const sshArgs = (key: string, extra: readonly string[]) => [
  "-i",
  key,
  "-o",
  `Port=${String(gatewayPort)}`,
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "BatchMode=yes",
  "-o",
  "LogLevel=ERROR",
  ...extra,
  `ws-${WORKSPACE_ID}@127.0.0.1`,
];

/** Runs OpenSSH's client, answering its stdout, stderr and exit code. */
const ssh = (
  key: string,
  extra: readonly string[],
  command?: string,
  stdin?: string,
  program = "ssh",
) =>
  new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(
      program,
      [...sshArgs(key, extra), ...(command === undefined ? [] : [command])],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(stdin ?? "");
  });

const dockerExec = (script: string) => run("docker", ["exec", containerId, "sh", "-c", script]);

beforeAll(async () => {
  if (!runsAsUser) return;
  scratch = await mkdtemp(join(tmpdir(), "sealant-ssh-user-e2e-"));

  // A plain executor of the per-person image; its people are Mend's range in the `mend` group.
  const worktree = join(scratch, "worktree");
  await mkdir(worktree);
  await writeFile(join(worktree, "README.md"), "ssh user e2e\n");
  const adapter = new DockerRuntimeAdapter({
    autoRemove: false,
    containerNamePrefix: "sealant-ssh-user-e2e",
    runtimeCatalogLoader: async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) }),
    mountAllowedStoreRoots: scratch,
  });
  const launched = await adapter.launch(
    parseRuntimeAdapterLaunchInput({
      blueprint: {
        version: "1",
        sources: { workspace: { kind: "mount", hostPath: worktree }, inputs: [], mounts: [] },
        harness: { id: "opencode" },
        lifecycle: { setup: [], startup: { steps: [], foreground: { kind: "harness" } } },
        runtime: {
          env: { SEALANT_FOREGROUND_COMMAND: "sleep infinity" },
          network: { outbound: true },
        },
        target: { os: { family: "fedora" }, runtime: { family: "docker" } },
      },
      publishedImage: {
        repository: "sealant-workspace-fedora",
        tag: "latest",
        reference: IMAGE_REF,
        digestReference: IMAGE_REF,
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      runId: `ssh-user-e2e-${randomUUID()}`,
    }),
  );
  containerId = launched.resourceId;
  // The people as Mend's prepare makes them, as root: homes 0700, primary group mend.
  await dockerExec(
    [ALICE, BOB]
      .map(
        (person) =>
          `useradd -u ${String(person.uid)} -g mend -m -d ${person.home} -s /bin/bash ${person.name} && chmod 0700 ${person.home}`,
      )
      .join(" && "),
  );

  for (const name of ["alice", "bob"] as const) {
    const file = join(scratch, name);
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file]);
    keys[name] = file;
  }
  const principals = new Map([
    [await keyBlob(`${keys.alice}.pub`), OWNER],
    [await keyBlob(`${keys.bob}.pub`), OTHER],
  ]);

  // The stand-in API: the target for the owner only, with the workspace's user, as the real
  // `GET /v1/workspaces/:id/ssh-target` answers it; every other route (run recording) is a 404,
  // which the gateway treats as recording unavailable.
  api = createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === `/v1/workspaces/${WORKSPACE_ID}/ssh-target`) {
      if (request.headers["x-sealant-principal-id"] !== OWNER) {
        reply(401, { message: "Principal is not authorized for this workspace." });
        return;
      }
      if (workspaceUser !== undefined && request.headers["x-sealant-gateway-ssh-user"] !== "1") {
        reply(409, { message: "This SSH gateway cannot run sessions as a user." });
        return;
      }
      reply(200, {
        workspaceId: WORKSPACE_ID,
        attemptId: "run_1",
        runtime: {
          adapter: "docker",
          resourceId: containerId,
          reference: containerId,
          status: "ready",
          endpoint: `docker://${containerId}`,
        },
        ...(workspaceUser === undefined ? {} : { user: workspaceUser }),
      });
      return;
    }
    reply(404, { message: "not here" });
  });
  const apiPort = await freePort();
  await new Promise<void>((resolve) => api?.listen(apiPort, "127.0.0.1", resolve));

  gatewayPort = await freePort();
  const hostKey = ssh2.utils.generateKeyPairSync("ed25519");
  gateway = await startSshGatewayServer({
    host: "127.0.0.1",
    port: gatewayPort,
    hostKey: hostKey.private,
    allowedClientKeys: [],
    workspaceUsernamePrefix: "ws",
    coreApiBaseUrl: `http://127.0.0.1:${String(apiPort)}`,
    gatewayToken: "gateway-e2e-token",
    lookupPrincipal: async (key) => {
      const principalId = principals.get(Buffer.from(key.data).toString("base64"));
      return principalId === undefined ? { kind: "not-found" } : { kind: "found", principalId };
    },
  });
}, 180_000);

afterAll(async () => {
  await gateway?.stop().catch(() => undefined);
  await new Promise<void>((resolve) =>
    api === undefined ? resolve() : api.close(() => resolve()),
  );
  if (containerId !== "") await run("docker", ["rm", "-f", containerId]).catch(() => undefined);
  if (scratch !== "") await rm(scratch, { recursive: true, force: true });
});

const IDENTITY = 'id -un; echo "$HOME"; stat -c "%U %a" "$HOME"';

describe.skipIf(!runsAsUser)("a workspace's SSH sessions as its user", () => {
  it("lands the owner as the workspace's user, in their 0700 home, in an exec and a PTY shell", async () => {
    workspaceUser = ALICE.name;
    const exec = await ssh(keys.alice, [], IDENTITY);
    expect(exec.code, exec.stderr).toBe(0);
    expect(exec.stdout).toBe(`${ALICE.name}\n${ALICE.home}\n${ALICE.name} 700\n`);

    const shell = await ssh(keys.alice, ["-tt"], undefined, `${IDENTITY}; exit\n`);
    expect(shell.stdout).toContain(`${ALICE.name} 700`);
    expect(shell.stdout).not.toMatch(/^root$/m);
  });

  it("runs what VS Code Remote-SSH's bootstrap does: a server in ~/.vscode-server, reached through a forward", async () => {
    workspaceUser = ALICE.name;
    // The bootstrap shape: `ssh -T host bash`, a script on stdin, markers on stdout; the server
    // listens on loopback inside the workspace and the client forwards a local port to it.
    const install = [
      "set -e",
      'server="$HOME/.vscode-server/bin/e2e"',
      'mkdir -p "$server" "$HOME/.vscode-server/data/Machine"',
      `cat > "$server/server.js" <<'JS'`,
      `require("node:http").createServer((_, res) => res.end(require("node:os").userInfo().username + "\\n")).listen(${String(SERVER_PORT)}, "127.0.0.1");`,
      "JS",
      'echo "{}" > "$HOME/.vscode-server/data/Machine/settings.json"',
      `nohup node "$server/server.js" > "$HOME/.vscode-server/server.log" 2>&1 &`,
      "for _ in $(seq 1 50); do curl -fsS http://127.0.0.1:" +
        String(SERVER_PORT) +
        "/ >/dev/null 2>&1 && break; sleep 0.1; done",
      'echo "listeningOn==' + String(SERVER_PORT) + '=="',
      'stat -c "owner==%U==" "$HOME/.vscode-server" "$server/server.js"',
    ].join("\n");
    const bootstrap = await ssh(keys.alice, ["-T"], "bash", `${install}\n`);
    expect(bootstrap.code, bootstrap.stderr).toBe(0);
    expect(bootstrap.stdout).toContain(`listeningOn==${String(SERVER_PORT)}==`);
    expect(bootstrap.stdout.match(/owner==(\S+)==/g)).toEqual([
      `owner==${ALICE.name}==`,
      `owner==${ALICE.name}==`,
    ]);

    // The editor's connection: a local port forwarded through the gateway to the server.
    const localPort = await freePort();
    const forward = spawn(
      "ssh",
      [
        ...sshArgs(keys.alice, [
          "-N",
          "-L",
          `${String(localPort)}:127.0.0.1:${String(SERVER_PORT)}`,
        ]),
      ],
      { stdio: "ignore" },
    );
    try {
      let answer = "";
      for (let attempt = 0; attempt < 50 && answer === ""; attempt += 1) {
        answer = await fetch(`http://127.0.0.1:${String(localPort)}/`)
          .then((response) => response.text())
          .catch(() => "");
        if (answer === "") await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(answer).toBe(`${ALICE.name}\n`);
    } finally {
      forward.kill();
    }
  });

  it("refuses another person's key: only the workspace's owner opens a session", async () => {
    workspaceUser = ALICE.name;
    const refused = await ssh(keys.bob, [], IDENTITY);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout).toBe("");
  });

  it("refuses SFTP for a workspace with a user rather than run it as root", async () => {
    workspaceUser = ALICE.name;
    const sftp = await ssh(keys.alice, ["-b", "-"], undefined, "pwd\n", "sftp");
    expect(sftp.code).not.toBe(0);
    // The gateway's refusal, not a missing sftp-server: nothing was opened as root.
    expect(sftp.stderr).toContain("SFTP is not available in this workspace yet");
  });

  it("runs a workspace without a user as root, as before", async () => {
    workspaceUser = undefined;
    const exec = await ssh(keys.alice, [], IDENTITY);
    expect(exec.code, exec.stderr).toBe(0);
    expect(exec.stdout.split("\n").slice(0, 2)).toEqual(["root", "/root"]);
  });
});
