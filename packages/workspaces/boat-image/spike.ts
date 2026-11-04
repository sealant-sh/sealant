import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access as fileAccess,
  chmod,
  mkdtemp,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SealantClient } from "@sealant/runtime-client";
import { WebSocket, createWebSocketStream } from "ws";
import { z } from "zod";

import { HttpBoatApi } from "../src/runtime/boat/api.js";
import {
  BoatApiError,
  BoatSecret,
  boatDeletionIdSchema,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  type BoatResult,
  type BoatSandboxId,
} from "../src/runtime/boat/config.js";
import { boatControlConnection, type BoatHostedControl } from "../src/runtime/boat/connection.js";

const credentialInput = process.env.BOAT_API_KEY;
delete process.env.BOAT_API_KEY;
const credential = BoatSecret.parse(credentialInput);
const options = new Map<string, string>();
const argumentsList = process.argv.slice(2);
for (let index = 0; index < argumentsList.length; index += 2) {
  const name = argumentsList[index];
  const value = argumentsList[index + 1];
  if (!name || !value || !["--sealantd", "--cleanup"].includes(name) || options.has(name)) {
    process.stderr.write(
      "Usage: spike.ts --sealantd /absolute/native/sealantd | --cleanup /absolute/ownership.json\n",
    );
    process.exit(2);
  }
  options.set(name, value);
}
const must = <T>(result: BoatResult<T>): T => {
  if (!result.ok) throw result.error;
  return result.value;
};
const api = credential.ok ? must(HttpBoatApi.create({ credential: credential.value })) : undefined;
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let interrupted = false;
let cleaning = false;
const ensureRunning = () => {
  if (interrupted && !cleaning) throw new BoatApiError("spike", null, "interrupted");
};
process.once("SIGINT", () => {
  interrupted = true;
});
process.once("SIGTERM", () => {
  interrupted = true;
});
const poll = async <T>(
  operation: string,
  check: () => Promise<T | undefined>,
  limit = 150,
): Promise<T> => {
  for (let attempt = 0; attempt < limit; attempt++) {
    ensureRunning();
    const value = await check();
    if (value !== undefined) return value;
    await pause(2000);
  }
  throw new BoatApiError(operation, null, "poll_timeout");
};
const journalSchema = z.object({
  version: z.literal(1),
  marker: z.uuid(),
  allocation: z
    .object({
      key: z.uuid(),
      requestedAt: z.iso.datetime(),
      from: boatSnapshotNameSchema.optional(),
      id: boatSandboxIdSchema.optional(),
      deletion: boatDeletionIdSchema.optional(),
    })
    .optional(),
  snapshot: z
    .object({
      name: boatSnapshotNameSchema,
      source: boatSandboxIdSchema,
      createdAt: z.iso.datetime().optional(),
      artifact: z.string().optional(),
    })
    .optional(),
});
type Journal = z.infer<typeof journalSchema>;
let journal: Journal;
let journalPath: string;
const persist = async () => {
  const temporary = `${journalPath}.next`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  const file = await open(temporary, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, journalPath);
  const directory = await open(resolve(journalPath, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};
const command = async (id: BoatSandboxId, text: string) => {
  ensureRunning();
  if (!api) throw new BoatApiError("config", null, "invalid_credential");
  const result = must(await api.execute(id, text));
  if (result.exitCode !== 0 || result.timedOut)
    throw new BoatApiError("guest_command", null, "command_failed");
  return result.stdout;
};
const allocate = async (from?: z.infer<typeof boatSnapshotNameSchema>) => {
  ensureRunning();
  if (!api || journal.allocation) throw new BoatApiError("create", null, "allocation_not_clean");
  journal.allocation = {
    key: randomUUID(),
    requestedAt: new Date().toISOString(),
    ...(from === undefined ? {} : { from }),
  };
  await persist();
  let result = await api.create({
    marker: journal.marker,
    idempotencyKey: journal.allocation.key,
    ...(from === undefined ? {} : { from }),
  });
  for (
    let retry = 0;
    !result.ok &&
    retry < 2 &&
    (result.error.status === null ||
      result.error.status >= 500 ||
      result.error.code === "idempotency_in_progress");
    retry++
  ) {
    await pause(2000);
    result = await api.create({
      marker: journal.marker,
      idempotencyKey: journal.allocation.key,
      ...(from === undefined ? {} : { from }),
    });
  }
  const sandbox = must(result);
  journal.allocation.id = sandbox.id;
  await persist();
  await poll("sandbox_ready", async () => {
    const state = must(await api.get(sandbox.id));
    if (["cancelled", "error"].includes(state.state))
      throw new BoatApiError("sandbox_ready", null, "sandbox_failed");
    return ["ready", "idle", "running"].includes(state.state) ? state : undefined;
  });
  return sandbox.id;
};
const cleanupSandbox = async () => {
  if (!api || !journal.allocation) return;
  const allocation = journal.allocation;
  if (!allocation.id) {
    if (Date.now() - Date.parse(allocation.requestedAt) >= 23 * 60 * 60 * 1000)
      throw new BoatApiError("cleanup", null, "idempotency_window_expired");
    const recovered = must(
      await api.create({
        marker: journal.marker,
        idempotencyKey: allocation.key,
        ...(allocation.from === undefined ? {} : { from: allocation.from }),
      }),
    );
    allocation.id = recovered.id;
    await persist();
  }
  const id = allocation.id;
  if (!allocation.deletion) {
    const deletion = must(await api.deleteSandbox(id));
    if (deletion.targetId !== id)
      throw new BoatApiError("cleanup", null, "deletion_identity_mismatch");
    allocation.deletion = deletion.id;
    await persist();
  }
  const deletionId = allocation.deletion;
  await poll("sandbox_delete", async () => {
    const operation = must(await api.getDeletion(deletionId));
    if (operation.targetId !== id || operation.id !== deletionId)
      throw new BoatApiError("cleanup", null, "deletion_identity_mismatch");
    if (operation.status === "blocked") throw new BoatApiError("cleanup", null, "deletion_blocked");
    return operation.status === "completed" ? operation : undefined;
  });
  journal.allocation = undefined;
  await persist();
};
const cleanup = async () => {
  cleaning = true;
  await cleanupSandbox();
  if (!api || !journal.snapshot) return;
  const owned = journal.snapshot;
  const snapshot = await poll("snapshot_cleanup", async () => {
    const result = await api.getSnapshot(owned.name);
    if (!result.ok && result.error.status === 404) return "absent";
    const found = must(result);
    if (
      found.sourceSandboxId !== owned.source ||
      found.name !== owned.name ||
      (owned.createdAt !== undefined && owned.createdAt !== found.createdAt) ||
      (owned.artifact !== undefined && owned.artifact !== found.snapshotId)
    )
      throw new BoatApiError("cleanup", null, "snapshot_identity_mismatch");
    return found.status === "saving" ? undefined : found;
  });
  if (snapshot !== "absent") must(await api.deleteSnapshot(owned.name));
  journal.snapshot = undefined;
  await persist();
};
const socketProbe = async (access: BoatHostedControl, token: BoatSecret, query: boolean) => {
  const connection = boatControlConnection(access, token);
  const headers = (await connection.prepare()).headers;
  const url = new URL(connection.url);
  url.searchParams.set("probe", "query-route");
  const actualHeaders = { ...headers };
  if (query) {
    delete actualHeaders.Cookie;
    url.searchParams.set("_token", access.cookie.reveal());
  }
  const socket = new WebSocket(url, {
    headers: actualHeaders,
    handshakeTimeout: 10_000,
    perMessageDeflate: false,
    followRedirects: false,
  });
  const stream = createWebSocketStream(socket, { allowHalfOpen: false });
  stream.on("error", () => undefined);
  const client = SealantClient.fromStream(stream);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = new Promise<void>((done, failed) => {
      socket.once("open", () => done());
      socket.once("error", () => failed(new BoatApiError("control", null, "websocket_failed")));
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        failed(new BoatApiError("control", response.statusCode ?? null, "websocket_refused"));
      });
    });
    const healthAnsweredAt = await Promise.race([
      (async () => {
        await ready;
        await client.health();
        const answeredAt = performance.now();
        await client.getCapabilities();
        return answeredAt;
      })(),
      new Promise<never>((_done, failed) => {
        timeout = setTimeout(
          () => failed(new BoatApiError("control", null, "native_readiness_timeout")),
          15_000,
        );
      }),
    ]);
    return { upgrade: 101, health: true, capabilities: true, healthAnsweredAt };
  } finally {
    clearTimeout(timeout);
    client.close();
    stream.destroy();
    socket.terminate();
  }
};
const controlProbes = async (id: BoatSandboxId, token: BoatSecret) => {
  ensureRunning();
  if (!api) throw new BoatApiError("config", null, "invalid_credential");
  const access = must(await api.hostControl(id));
  const { healthAnsweredAt, ...cookieWebSocket } = await poll(
    "control_ready",
    async () => {
      try {
        return await socketProbe(access, token, false);
      } catch (error) {
        if (error instanceof BoatApiError && (error.status === null || error.status === 503))
          return undefined;
        throw error;
      }
    },
    15,
  );
  const status = async (
    mode: "cookie" | "query" | "no-proxy" | "no-relay" | "wrong-relay",
    path = "/sealant/health?probe=query-route",
  ) => {
    const url = new URL(path, access.origin);
    const headers: Record<string, string> = {};
    if (mode !== "no-relay")
      headers.Authorization = `Bearer ${mode === "wrong-relay" ? "wrong" : token.reveal()}`;
    if (mode === "query") url.searchParams.set("_token", access.cookie.reveal());
    else if (mode !== "no-proxy") headers.Cookie = `_port_auth=${access.cookie.reveal()}`;
    try {
      const response = await fetch(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      return response.status;
    } catch {
      throw new BoatApiError("health_probe", null, "transport_error");
    }
  };
  const result = {
    noProxy: await status("no-proxy"),
    noRelay: await status("no-relay"),
    wrongRelay: await status("wrong-relay"),
    cookieHealth: await status("cookie"),
    queryHealth: await status("query"),
    unknownRoute: await status("cookie", "/sealant/launch"),
    cookieWebSocket,
    queryWebSocket: await socketProbe(access, token, true).then(
      ({ healthAnsweredAt: _answeredAt, ...probeResult }) => probeResult,
    ),
  };
  if (
    result.noProxy !== 403 ||
    result.noRelay !== 401 ||
    result.wrongRelay !== 401 ||
    result.cookieHealth !== 200 ||
    result.unknownRoute !== 404
  ) {
    throw new BoatApiError("authentication_probe", null, "unexpected_authentication_result");
  }
  return { access, result, healthAnsweredAt };
};
const stopAndResume = async (id: BoatSandboxId, token: BoatSecret, before: BoatHostedControl) => {
  ensureRunning();
  if (!api) throw new BoatApiError("config", null, "invalid_credential");
  must(await api.stop(id));
  await poll("archive", async () =>
    must(await api.get(id)).state === "archived" ? true : undefined,
  );
  must(await api.resume(id));
  await poll("resume", async () =>
    ["ready", "idle", "running"].includes(must(await api.get(id)).state) ? true : undefined,
  );
  await command(
    id,
    "sudo systemctl restart sealant-boat-spike-daemon.service sealant-boat-spike-relay.service",
  );
  const after = await controlProbes(id, token);
  return {
    ...after.result,
    urlStable: before.origin === after.access.origin,
    tokenStable: before.cookie.reveal() === after.access.cookie.reveal(),
    cold: false,
  };
};
const run = async () => {
  if (!api) throw new BoatApiError("config", null, "invalid_credential");
  const cleanupPath = options.get("--cleanup");
  if (cleanupPath) {
    if (options.has("--sealantd")) throw new BoatApiError("config", null, "invalid_arguments");
    journalPath = resolve(cleanupPath);
    const file = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat();
      const parent = await stat(resolve(journalPath, ".."));
      const localUid = process.getuid?.();
      if (
        !metadata.isFile() ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.uid !== localUid ||
        !parent.isDirectory() ||
        (parent.mode & 0o077) !== 0 ||
        parent.uid !== localUid
      )
        throw new BoatApiError("cleanup", null, "invalid_journal_permissions");
      journal = journalSchema.parse(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
    if (
      journal.snapshot?.name !== undefined &&
      journal.snapshot.name !== `sealant-dev-boat-stream-${journal.marker}`
    )
      throw new BoatApiError("cleanup", null, "snapshot_identity_mismatch");
    await cleanup();
    process.stdout.write("Owned Boat objects deleted.\n");
    return;
  }
  const daemonInput = options.get("--sealantd");
  if (!daemonInput || !daemonInput.startsWith("/"))
    throw new BoatApiError("config", null, "native_daemon_required");
  const daemon = await readFile(daemonInput);
  await fileAccess(daemonInput, constants.X_OK);
  if (
    !(await stat(daemonInput)).isFile() ||
    daemon.length < 64 ||
    daemon.subarray(0, 4).toString("hex") !== "7f454c46" ||
    daemon[4] !== 2 ||
    daemon[5] !== 1 ||
    daemon.readUInt16LE(18) !== 62
  )
    throw new BoatApiError("config", null, "invalid_native_daemon");
  const directory = await mkdtemp(join(tmpdir(), "sealant-boat-stream-"));
  await chmod(directory, 0o700);
  journalPath = join(directory, "ownership.json");
  journal = { version: 1, marker: randomUUID() };
  await persist();
  process.stdout.write(`Ownership record: ${journalPath}\n`);
  const artifact = join(directory, "control-relay.cjs");
  await new Promise<void>((done, failed) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./build-relay.mjs", import.meta.url)), artifact],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: "ignore" },
    );
    child.once("error", () => failed(new BoatApiError("bundle", null, "build_failed")));
    child.once("exit", (code) =>
      code === 0 ? done() : failed(new BoatApiError("bundle", null, "build_failed")),
    );
  });
  const report: Record<string, unknown> = {
    marker: journal.marker,
    daemonSha256: createHash("sha256").update(daemon).digest("hex"),
    daemonCompatibility:
      "transport-only; version and production compatibility must be established separately",
    coldLaunch: "inconclusive",
    cleanup: "pending",
  };
  const stage = `/home/user/sealant-dev-boat-stream-${journal.marker}`;
  const guest = "/var/lib/sealant-boat-stream";
  const snapshotName = boatSnapshotNameSchema.parse(`sealant-dev-boat-stream-${journal.marker}`);
  const token = must(BoatSecret.parse(randomBytes(32).toString("hex")));
  const seedToken = async (id: BoatSandboxId) => {
    must(await api.writeFile(id, `${stage}/relay.token`, token));
    await command(
      id,
      `chmod 600 '${stage}/relay.token'\nsudo install -m600 '${stage}/relay.token' '${guest}/relay.token'\nrm '${stage}/relay.token'`,
    );
  };
  let failure: unknown;
  try {
    const id = await allocate();
    const base = z
      .object({
        id: z.string(),
        version: z.string(),
        name: z.string(),
        arch: z.literal("x64"),
        node: z.string(),
        nodePath: z.string().regex(/^\/[A-Za-z0-9._/-]+$/),
      })
      .parse(
        JSON.parse(
          await command(
            id,
            `node -e 'const fs=require("node:fs"); const os=Object.fromEntries(fs.readFileSync("/etc/os-release","utf8").trim().split("\\n").filter(x=>x.includes("=")).map(x=>{let i=x.indexOf("=");return [x.slice(0,i),x.slice(i+1).replace(/^"|"$/g,"")]})); console.log(JSON.stringify({id:os.ID,version:os.VERSION_ID,name:os.PRETTY_NAME,arch:process.arch,node:process.version,nodePath:process.execPath}))'`,
          ),
        ),
      );
    report.base = base;
    await command(
      id,
      `install -d -m700 '${stage}'\nsudo install -d -m700 '${guest}' '${guest}/workspace'`,
    );
    must(await api.uploadFile(id, `${stage}/sealantd`, daemon));
    must(await api.uploadFile(id, `${stage}/control-relay.cjs`, await readFile(artifact)));
    await command(
      id,
      `sudo install -m755 '${stage}/sealantd' '${guest}/sealantd'\nsudo install -m600 '${stage}/control-relay.cjs' '${guest}/control-relay.cjs'`,
    );
    for (const [name, content] of [
      [
        "daemon",
        `[Unit]\nDescription=Sealant boat transport spike daemon\n[Service]\nExecStart=${guest}/sealantd --socket ${guest}/control.sock --workspace ${guest}/workspace --log-level warn\nKillMode=control-group\n[Install]\nWantedBy=multi-user.target\n`,
      ],
      [
        "relay",
        `[Unit]\nDescription=Sealant boat transport spike relay\nAfter=sealant-boat-spike-daemon.service\n[Service]\nExecStart=${base.nodePath} ${guest}/control-relay.cjs --token-file ${guest}/relay.token --socket ${guest}/control.sock --port 8080\nKillMode=control-group\n[Install]\nWantedBy=multi-user.target\n`,
      ],
    ]) {
      if (!name || !content) throw new BoatApiError("config", null, "invalid_unit");
      must(await api.writeFile(id, `${stage}/${name}.service`, content));
      await command(
        id,
        `chmod 600 '${stage}/${name}.service'\nsudo install -m644 '${stage}/${name}.service' '/etc/systemd/system/sealant-boat-spike-${name}.service'`,
      );
    }
    await command(
      id,
      "sudo systemctl daemon-reload\nsudo systemctl enable sealant-boat-spike-daemon.service sealant-boat-spike-relay.service",
    );
    journal.snapshot = { name: snapshotName, source: id };
    await persist();
    ensureRunning();
    const saved = await api.saveSnapshot(id, snapshotName);
    if (!saved.ok && saved.error.code === "trial_saved_snapshots_not_allowed") {
      report.snapshot = {
        outcome: "inconclusive",
        code: saved.error.code,
        reason: "account forbids saved snapshots; cold launch latency not measured",
      };
      journal.snapshot = undefined;
      await persist();
    } else {
      const snapshot = must(saved);
      if (snapshot.sourceSandboxId !== id || snapshot.name !== snapshotName)
        throw new BoatApiError("saveSnapshot", null, "snapshot_identity_mismatch");
      journal.snapshot.createdAt = snapshot.createdAt;
      await persist();
      const ready = await poll(
        "snapshot_ready",
        async () => {
          const current = must(await api.getSnapshot(snapshotName));
          if (
            current.sourceSandboxId !== id ||
            current.createdAt !== snapshot.createdAt ||
            current.name !== snapshotName
          )
            throw new BoatApiError("saveSnapshot", null, "snapshot_identity_mismatch");
          if (current.status === "failed")
            throw new BoatApiError("saveSnapshot", null, "snapshot_failed");
          return current.status === "ready" && current.snapshotId ? current : undefined;
        },
        240,
      );
      journal.snapshot.artifact = ready.snapshotId;
      await persist();
      report.snapshot = {
        name: ready.name,
        source: id,
        artifact: ready.snapshotId,
        ownership:
          "unique name, labelled source and immutable metadata; API has no snapshot labels",
      };
    }
    await seedToken(id);
    await command(
      id,
      "sudo systemctl start sealant-boat-spike-daemon.service sealant-boat-spike-relay.service",
    );
    const before = await controlProbes(id, token);
    report.fresh = before.result;
    report.resume = await stopAndResume(id, token, before.access);
    await cleanupSandbox();
    if (journal.snapshot) {
      const started = performance.now();
      const cold = await allocate(snapshotName);
      report.coldProviderReadyMs = Math.round(performance.now() - started);
      await command(cold, `install -d -m700 '${stage}'`);
      await seedToken(cold);
      await command(
        cold,
        "sudo systemctl restart sealant-boat-spike-daemon.service sealant-boat-spike-relay.service",
      );
      const coldProbes = await controlProbes(cold, token);
      report.cold = coldProbes.result;
      report.coldCreateToHealthMs = Math.round(coldProbes.healthAnsweredAt - started);
      report.coldLaunch = "verified";
      report.coldResume = await stopAndResume(cold, token, coldProbes.access);
    }
  } catch (error) {
    failure = error;
    report.failure =
      error instanceof BoatApiError
        ? { operation: error.operation, status: error.status, code: error.code }
        : { code: "local_spike_failure" };
  } finally {
    try {
      await cleanup();
      report.cleanup = "completed";
    } catch (error) {
      failure = error;
      report.cleanup =
        error instanceof BoatApiError
          ? { operation: error.operation, status: error.status, code: error.code }
          : { code: "cleanup_failed" };
    }
    await writeFile(join(directory, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(`Nonsecret evidence: ${join(directory, "evidence.json")}\n`);
  }
  if (failure) throw failure;
  if (report.coldLaunch === "inconclusive") {
    process.stdout.write("Transport probes passed. Cold saved-snapshot launch is INCONCLUSIVE.\n");
    process.exitCode = 2;
  }
};

try {
  await run();
} catch (error) {
  process.stderr.write(
    `${error instanceof BoatApiError ? error.message : "Boat spike failed locally; no diagnostic payload recorded"}\n`,
  );
  process.exitCode = 1;
}
