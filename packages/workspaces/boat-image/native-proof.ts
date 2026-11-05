import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { SealantClient } from "@sealant/runtime-client";
import { RuntimeState } from "@sealant/runtime-protocol";
import { parseWorkspaceBlueprint } from "@sealant/validators";
import { WebSocket, createWebSocketStream } from "ws";
import { z } from "zod";

import { BoatSnapshotBuilder, type NativeSnapshotArtifact } from "../src/images/boat/builder.js";
import {
  VerifiedRuntimeBundle,
  NativeBuildError,
  sha256,
  type NativeResult,
} from "../src/images/boat/runtime-bundle.js";
import { HttpBoatApi, type BoatApi } from "../src/runtime/boat/api.js";
import {
  BoatSecret,
  boatSandboxIdSchema,
  boatDeletionIdSchema,
  boatSnapshotNameSchema,
  type BoatResult,
  type BoatSandboxId,
} from "../src/runtime/boat/config.js";
import { boatControlConnection } from "../src/runtime/boat/connection.js";

const must = <T>(r: BoatResult<T> | NativeResult<T>): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
const noop = () => undefined;
const credential = must(BoatSecret.parse(process.env.BOAT_API_KEY));
delete process.env.BOAT_API_KEY;
const [family, bundleDirectory, outputInput, mode] = process.argv.slice(2);
if ((family !== "ubuntu" && family !== "nix") || !bundleDirectory || !outputInput)
  throw new Error("Usage: native-proof.ts ubuntu|nix /absolute/bundle /absolute/private-output");
const output = resolve(outputInput);
await mkdir(output, { mode: 0o700 });
const runnerHash = sha256(await readFile(new URL(import.meta.url)));
const fixtureBytes = await readFile(new URL("./fixtures/mend-screens.json", import.meta.url));
const fixture = z
  .object({
    provenance: z.record(z.string(), z.unknown()),
    ubuntu: z.object({ blueprint: z.unknown() }),
    nix: z.object({ blueprint: z.unknown() }),
  })
  .parse(JSON.parse(fixtureBytes.toString("utf8")));
const spec = parseWorkspaceBlueprint(fixture[family].blueprint);
const bytes = await Promise.all(
  ["source-index.json", "platform-manifest.json", "sealantd", "socat", "control-relay.cjs"].map(
    (p) => readFile(join(bundleDirectory, p)),
  ),
);
const [sourceIndex, platformManifest, sealantd, socat, relay] = bytes;
if (!sourceIndex || !platformManifest || !sealantd || !socat || !relay)
  throw new Error("missing bundle file");
const bundle = must(
  VerifiedRuntimeBundle.parse({ sourceIndex, platformManifest, sealantd, socat, relay }),
);
const httpApi = must(HttpBoatApi.create({ credential }));
const events: unknown[] = [];
let cancellationProbe = false;
const api: BoatApi = {
  create: httpApi.create.bind(httpApi),
  get: httpApi.get.bind(httpApi),
  writeFile: httpApi.writeFile.bind(httpApi),
  uploadFile: httpApi.uploadFile.bind(httpApi),
  hostControl: httpApi.hostControl.bind(httpApi),
  stop: httpApi.stop.bind(httpApi),
  resume: httpApi.resume.bind(httpApi),
  deleteSnapshot: httpApi.deleteSnapshot.bind(httpApi),
  getSnapshot: httpApi.getSnapshot.bind(httpApi),
  async execute(id, command, options) {
    if (mode === "cancel" && !cancellationProbe) {
      cancellationProbe = true;
      const diagnostics = must(
        await httpApi.execute(
          id,
          `set -u
/usr/bin/sudo install -d -m700 /var/lib/sealant/control
/usr/bin/sudo unshare --mount --pid --fork --mount-proc /bin/sh -c 'test "$$" = 1; echo namespace-pid1-ok'
for protection in ProtectControlGroups=yes 'InaccessiblePaths=-/var/run/dbus -/var/run/systemd -/var/lib/dbus/system_bus_socket'; do
  /usr/bin/sudo systemd-run --wait --collect -p PrivateMounts=yes -p TemporaryFileSystem=/run:rw,nosuid,nodev -p BindPaths=/var/lib/sealant/control:/run/sealant -p "$protection" /bin/true
  echo "$protection result=$?"
done`,
          { timeoutSeconds: 30 },
        ),
      );
      events.push({ namespaceDiagnostics: diagnostics });
      runAbort.abort();
      return { ok: true, value: diagnostics };
    }
    const result = await httpApi.execute(id, command, options);
    if (!result.ok)
      events.push({
        guestCommandFailure: {
          sandbox: id,
          code: result.error.code,
          status: result.error.status,
        },
      });
    if (result.ok && (result.value.exitCode !== 0 || result.value.timedOut))
      await writeFile(
        join(output, "guest-command-failure.json"),
        JSON.stringify(result.value, null, 2) + "\n",
        { mode: 0o600 },
      );
    return result;
  },
  async saveSnapshot(id, name) {
    const check = must(
      await httpApi.execute(
        id,
        "set -eu\n/usr/bin/sudo test ! -e /var/lib/sealant/setup-marker; /usr/bin/sudo test ! -e /var/lib/sealant/startup-marker; /usr/bin/sudo test ! -e /var/lib/sealant/control/launch.json; /usr/bin/sudo test -f /root/README",
      ),
    );
    if (check.exitCode !== 0) throw new Error("build lifecycle or public dotfiles proof failed");
    const saved = await httpApi.saveSnapshot(id, name);
    if (saved.ok) events.push({ save: saved.value });
    return saved;
  },
  async deleteSandbox(id) {
    const result = await httpApi.deleteSandbox(id);
    if (result.ok) events.push({ deleteRequested: id, operation: result.value.id });
    return result;
  },
  async getDeletion(id) {
    const result = await httpApi.getDeletion(id);
    if (result.ok && result.value.status === "completed")
      events.push({ deletionCompleted: result.value });
    return result;
  },
};
const owner = randomUUID();
const journalDirectory = join(output, "attempts");
const builder = new BoatSnapshotBuilder({ api, runtimeBundle: bundle, journalDirectory, owner });
const stateSchema = z.object({
  owner: z.uuid(),
  artifact: z.unknown().optional(),
  artifactJournal: z.string().optional(),
  clone: z
    .object({
      marker: z.uuid(),
      key: z.uuid(),
      requestedAt: z.iso.datetime(),
      from: boatSnapshotNameSchema,
      id: boatSandboxIdSchema.optional(),
      deletionIntent: z.literal(true).optional(),
      deletion: boatDeletionIdSchema.optional(),
      deleted: z.boolean().optional(),
    })
    .optional(),
});
type State = z.infer<typeof stateSchema>;
const state: State = { owner };
const runAbort = new AbortController();
const persist = async () => {
  const path = join(output, "proof-ownership.json");
  const fd = await open(path + ".next", "w", 0o600);
  try {
    await fd.writeFile(JSON.stringify(state, null, 2) + "\n");
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(path + ".next", path);
  const d = await open(output, "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const poll = async <T>(
  check: () => Promise<T | undefined>,
  signal = runAbort.signal,
  attempts = 90,
): Promise<T> => {
  for (let n = 0; n < attempts; n++) {
    if (signal.aborted) throw new Error("proof interrupted");
    const r = await check();
    if (r !== undefined) return r;
    await pause(1000);
  }
  throw new Error("proof poll timed out");
};
const command = async (id: BoatSandboxId, text: string, timeoutSeconds = 30) => {
  const result = must(
    await api.execute(
      id,
      `set -eux\nexport PATH=/usr/local/bin:/nix/var/nix/profiles/default/bin:/usr/sbin:/usr/bin:/sbin:/bin\n${text}`,
      { timeoutSeconds, signal: runAbort.signal },
    ),
  );
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error("guest proof failed; see guest-command-failure.json");
  return result.stdout;
};
const createClone = async () => {
  const clone = state.clone;
  if (!clone || Date.now() - Date.parse(clone.requestedAt) >= 23 * 60 * 60 * 1000)
    throw new Error("unsafe clone reconciliation");
  const result = must(
    await api.create({
      marker: clone.marker,
      idempotencyKey: clone.key,
      from: clone.from,
      purpose: "native-build",
    }),
  );
  clone.id = result.id;
  await persist();
  return result.id;
};
let artifact: NativeSnapshotArtifact | undefined;
let client: SealantClient | undefined;
let websocket: WebSocket | undefined;
const interrupt = () => {
  runAbort.abort();
  client?.close();
  websocket?.terminate();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const report: Record<string, unknown> = {
  family,
  runtime: bundle.identity,
  provenance: fixture.provenance,
  proof: { runnerHash, fixtureHash: sha256(fixtureBytes) },
  events,
};
await persist();
try {
  if (mode === "cancel") {
    const cancelled = await builder.build({
      spec,
      signal: runAbort.signal,
    });
    if (cancelled.ok || cancelled.error.code !== "native-interrupted")
      throw new Error("real cancellation did not finish recorded-ID cleanup");
    report.cancellation = { code: cancelled.error.code, journalPath: cancelled.error.journalPath };
    if (cancelled.error.journalPath !== undefined) {
      state.artifactJournal = cancelled.error.journalPath;
      await persist();
    }
    report.result = "passed";
  } else {
    const built = must(
      await builder.build({
        spec,
        signal: runAbort.signal,
        onProgress: (phase) => process.stdout.write(JSON.stringify({ family, phase }) + "\n"),
      }),
    );
    artifact = built.artifact;
    state.artifact = artifact;
    if (built.journalPath !== undefined) state.artifactJournal = built.journalPath;
    await persist();
    report.artifact = artifact;
    if (must(await builder.findPublished({ spec, previous: artifact })) === null)
      throw new Error("explicit reuse failed");
    const reused = must(await builder.build({ spec, previous: artifact }));
    if (reused.outcome !== "reused") throw new Error("reuse allocated another source");
    state.clone = {
      marker: randomUUID(),
      key: randomUUID(),
      requestedAt: new Date().toISOString(),
      from: artifact.identity.name,
    };
    await persist();
    const coldStarted = performance.now();
    const id = await createClone();
    await poll(async () =>
      ["ready", "idle", "running"].includes(must(await api.get(id)).state) ? true : undefined,
    );
    report.coldClone = id;
    const initial = await command(
      id,
      `/usr/bin/sudo sha256sum /etc/sealant/native-receipt.json /usr/local/bin/sealantd /usr/local/bin/socat
/usr/bin/sudo test ! -e /var/lib/sealant/control/launch.json
/usr/bin/sudo test ! -e /var/lib/sealant/setup-marker
/usr/bin/sudo test ! -e /var/lib/sealant/startup-marker
/usr/bin/sudo /usr/local/lib/sealant/image-probe --require
! /usr/bin/sudo systemctl is-active --quiet sealant-workspace.service
case "$(/usr/bin/sudo systemctl is-enabled sealant-workspace.service || true)" in static|disabled) ;; *) exit 1 ;; esac
/usr/bin/sudo test -f /root/README
test ! -e /workspace/repo/.git
/usr/bin/sudo useradd -m -u 41000 -g mend -s /bin/bash proof-person
/usr/bin/sudo -u proof-person env PATH=/usr/local/bin:/usr/bin:/bin sudo -n id -u
/usr/bin/sudo systemd-run --quiet --unit=sealant-proof-sentinel /bin/sleep 600
/usr/bin/sudo install -d -m700 /var/lib/sealant/proof-repo
/usr/bin/sudo git -C /var/lib/sealant/proof-repo init -q
/usr/bin/sudo git -C /var/lib/sealant/proof-repo -c user.name=Proof -c user.email=proof@example.invalid commit -qm initial --allow-empty
install -d -m700 /home/user/sealant-dev-boat-stream-${state.clone.marker}
`,
      90,
    );
    if (
      !initial.includes(artifact.receiptHash) ||
      !initial.includes(bundle.identity.sealantd) ||
      !initial.includes(bundle.identity.socat)
    )
      throw new Error("cold receipt or runtime hash mismatch");
    report.coldInitial = initial;
    const stage = `/home/user/sealant-dev-boat-stream-${state.clone.marker}`;
    const token = must(BoatSecret.parse(randomBytes(32).toString("hex")));
    must(await api.writeFile(id, stage + "/relay.token", token));
    const descriptor = JSON.stringify({
      admission: "open",
      env: {
        SEALANT_WORKSPACE_SOURCE: "clone",
        SEALANT_WORKSPACE_REPO_URL: "file:///var/lib/sealant/proof-repo",
        SEALANT_HARNESS_LAUNCH_COMMAND: "/bin/sleep 600",
        SEALANT_HARNESS_BANNER: "native-proof",
        SEALANT_EXECUTION_ID: "proof-execution",
        SEALANT_WORKSPACE_ID: "proof-workspace",
      },
    });
    must(await api.writeFile(id, stage + "/launch.json", descriptor));
    await command(
      id,
      `/usr/bin/sudo install -m600 '${stage}/relay.token' /var/lib/sealant/control/relay.token
/usr/bin/sudo install -m600 '${stage}/launch.json' /var/lib/sealant/control/launch.json
/usr/bin/sudo systemctl daemon-reload
/usr/bin/sudo systemctl start sealant-workspace.service`,
    );
    const namespacePid = z
      .string()
      .regex(/^[1-9]\d*$/)
      .parse(
        (
          await command(
            id,
            `/usr/bin/sudo sh -c 'pid=$(systemctl show sealant-workspace.service -p MainPID --value); test "$(cat /proc/$pid/comm)" = unshare; printf "%s\\n" "$pid"'`,
          )
        ).trim(),
      );
    const namespaceSocket = `/proc/${namespacePid}/root/run/sealant/control.sock`;
    report.namespaceControl = { pid: namespacePid, socket: namespaceSocket };
    const relayNode = family === "nix" ? "/nix/var/nix/profiles/default/bin/node" : "/usr/bin/node";
    const relayUnit = `[Unit]\nDescription=Sealant proof relay\n[Service]\nExecStart=${relayNode} /usr/local/lib/sealant/control-relay.cjs --socket ${namespaceSocket} --token-file /var/lib/sealant/control/relay.token --port 8080\nKillMode=control-group\n`;
    must(await api.writeFile(id, stage + "/relay.service", relayUnit));
    await command(
      id,
      `/usr/bin/sudo install -m644 '${stage}/relay.service' /etc/systemd/system/sealant-proof-relay.service
/usr/bin/sudo systemctl daemon-reload
/usr/bin/sudo systemctl start sealant-proof-relay.service`,
    );
    await poll(
      async () => {
        const r = await command(
          id,
          `if /usr/bin/sudo test -S ${namespaceSocket}; then echo ready; elif /usr/bin/sudo systemctl is-failed --quiet sealant-workspace.service; then /usr/bin/sudo journalctl -u sealant-workspace.service -n 30 --no-pager; echo failed; else echo waiting; fi`,
        );
        if (r.trim().endsWith("failed")) {
          report.nativeBoot = r;
          throw new Error("native unit failed before control admission");
        }
        return r.trim() === "ready" ? true : undefined;
      },
      runAbort.signal,
      180,
    );
    report.localRelay = await command(
      id,
      `/usr/bin/sudo python3 - <<'PY'
import pathlib,time,urllib.request,urllib.error
token=pathlib.Path('/var/lib/sealant/control/relay.token').read_text()
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for attempt in range(30):
 try:
  request=urllib.request.Request('http://127.0.0.1:8080/sealant/health',headers={'Authorization':'Bearer '+token})
  with opener.open(request,timeout=2) as response:
   assert response.status==200
   print('local-relay-control-socket-reachable')
   break
 except (OSError,urllib.error.URLError) as error:
  print('local-relay-attempt',attempt,type(error).__name__,getattr(error,'code',None),flush=True)
  if attempt==29: raise SystemExit('local relay did not become ready')
  time.sleep(1)
PY`,
      90,
    );
    const access = must(await api.hostControl(id));
    const connection = boatControlConnection(access, token);
    const hostedStatuses: Array<number | "transport-error"> = [];
    report.hostedReadiness = hostedStatuses;
    await poll(
      async () => {
        let response: Response;
        try {
          response = await fetch(new URL("/sealant/health", access.origin), {
            headers: (await connection.prepare()).headers ?? {},
            signal: AbortSignal.timeout(5000),
            redirect: "manual",
          });
        } catch {
          hostedStatuses.push("transport-error");
          return undefined;
        }
        await response.body?.cancel();
        hostedStatuses.push(response.status);
        if (response.status === 502 || response.status === 503) return undefined;
        if (response.status !== 200) throw new Error(`hosted relay HTTP ${response.status}`);
        return true;
      },
      runAbort.signal,
      30,
    );
    const socket = new WebSocket(connection.url, {
      headers: (await connection.prepare()).headers,
      handshakeTimeout: 10_000,
    });
    websocket = socket;
    const stream = createWebSocketStream(socket, { allowHalfOpen: false });
    stream.on("error", () => undefined);
    await new Promise<void>((done, failed) => {
      socket.once("open", done);
      socket.once("error", failed);
    });
    client = SealantClient.fromStream(stream);
    const nativeHealth = await client.health();
    report.coldCreateToHealthMs = Math.round(performance.now() - coldStarted);
    const nativeCapabilities = await client.getCapabilities();
    report.nativeControl = {
      cookieHosted: true,
      health: nativeHealth,
      capabilities: nativeCapabilities,
    };
    if (
      nativeHealth.state !== RuntimeState.HEALTHY ||
      !["exec.user", "dotfiles.user", "restore.owner_map", "process.secret-env.v1"].every((c) =>
        nativeCapabilities.supports.includes(c),
      )
    )
      throw new Error("native health or required capabilities unavailable");
    process.stdout.write(
      JSON.stringify({ family, gate: "hosted-control", result: "passed" }) + "\n",
    );
    const inside = `set -euxo pipefail
trap 'status=$?; if [ "$status" -ne 0 ]; then ps -eo pid,ppid,stat,comm; for log in /workspace/xvnc.log /workspace/desktop.log /workspace/browser.log /workspace/nix-worker.log; do if [ -f "$log" ]; then echo "$log"; tail -n 60 "$log"; fi; done; fi' EXIT
test "$(cat /proc/1/comm)" = sealantd
grep '^NSpid:' /proc/1/status
test ! -S /run/systemd/private
test ! -S /var/run/systemd/private
test ! -S /run/dbus/system_bus_socket
test ! -S /var/run/dbus/system_bus_socket
if timeout 3 systemd-run --quiet --unit=sealant-escaped /bin/sleep 300; then exit 7; fi
test -f /var/lib/sealant/setup-marker
test -f /var/lib/sealant/startup-marker
getent ahostsv4 github.com >/dev/null
for cli in codex claude opencode pi; do env -i HOME=/tmp/fake-proof-home PATH="$PATH" OPENAI_API_KEY=fake ANTHROPIC_API_KEY=fake timeout 15 "$cli" --version; done
env -i HOME=/root PATH="$PATH" zsh -c 'echo selected-shell-ok'
setsid Xvnc :91 -geometry 800x600 -depth 24 -SecurityTypes None -localhost -nolisten tcp -rfbport 5991 >/workspace/xvnc.log 2>&1 &
xvnc=$!
export DISPLAY=:91
deadline=$((SECONDS + 90))
until xdpyinfo >/dev/null 2>&1; do
  kill -0 "$xvnc"
  test "$SECONDS" -lt "$deadline"
  sleep .2
done
setsid ${family === "nix" ? "openbox" : "dbus-run-session -- xfce4-session"} >/workspace/desktop.log 2>&1 &
desktop=$!
setsid chromium --no-sandbox --disable-dev-shm-usage --user-data-dir=/tmp/native-proof-browser --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 about:blank >/workspace/browser.log 2>&1 &
browser=$!
deadline=$((SECONDS + 90))
until curl -fsS http://127.0.0.1:9222/json/version >/workspace/browser-version.json 2>/dev/null; do
  kill -0 "$browser"
  test "$SECONDS" -lt "$deadline"
  sleep .2
done
cat /workspace/browser-version.json
kill -0 "$desktop"
ffmpeg -hide_banner -loglevel error -y -f x11grab -video_size 800x600 -framerate 5 -i :91 -t 2 -c:v libx264 /workspace/proof.mp4
test -s /workspace/proof.mp4
setsid /bin/sh -c 'while :; do echo writer >>/workspace/detached-writer; sleep .2; done' </dev/null >/dev/null 2>&1 &
${
  family === "nix"
    ? `setpriv --reuid=41000 --regid=40000 --init-groups getent ahostsv4 github.com >/dev/null
bashStore=$(dirname "$(dirname "$(readlink -f /nix/var/nix/profiles/default/bin/bash)")")
coreStore=$(dirname "$(dirname "$(readlink -f /nix/var/nix/profiles/default/bin/sleep)")")
cat >/workspace/native-worker.nix <<EOF
let bash = builtins.storePath "$bashStore"; core = builtins.storePath "$coreStore";
in builtins.derivation {
  name = "native-worker-proof";
  system = "x86_64-linux";
  builder = bash + "/bin/bash";
  args = [ "-c" ("exec " + core + "/bin/sleep 300") ];
}
EOF
setpriv --reuid=41000 --regid=40000 --init-groups env HOME=/home/proof-person PATH="$PATH" NIX_REMOTE=daemon nix --extra-experimental-features nix-command build --impure --no-link --file /workspace/native-worker.nix >/workspace/nix-worker.log 2>&1 &
for n in $(seq 1 200); do
  if ps -eo pid,user,args | awk '$2 ~ /^nixbld/ && /sleep 300/ {found=1} END {exit !found}'; then break; fi
  sleep .2
done
worker=$(ps -eo pid,user,args | awk '$2 ~ /^nixbld/ && /sleep 300/ {print $1; exit}')
test -n "$worker"
cat "/proc/$worker/cgroup"
cmp /proc/1/cgroup "/proc/$worker/cgroup"
test -S /nix/var/nix/daemon-socket/socket
pgrep -a nix-daemon`
    : ""
}
echo PROOF_INSIDE_COMPLETE
`;
    const attached = await client.execAttached({
      executable: "/bin/bash",
      args: ["-c", inside],
      timeoutMillis: 360_000,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of attached.channel) chunks.push(chunk);
    const insideOutput = Buffer.concat(chunks).toString("utf8");
    report.inside = insideOutput;
    if (!insideOutput.includes("PROOF_INSIDE_COMPLETE")) throw new Error("inside proof failed");
    const scope = await command(
      id,
      `/usr/bin/sudo systemctl show sealant-workspace.service -p ControlGroup -p MainPID
/usr/bin/sudo systemd-cgls --unit sealant-workspace.service --no-pager --full
/usr/bin/sudo systemctl is-active sealant-proof-sentinel.service
/usr/bin/sudo journalctl -u sealant-workspace.service -n 8 --no-pager`,
    );
    report.scope = scope;
    if (
      ![
        "Xvnc",
        "native-proof-browser",
        "detached-writer",
        family === "nix" ? "openbox" : "xfce4-session",
      ].every((writer) => scope.includes(writer))
    )
      throw new Error("expected writers did not remain in the session cgroup");
    if (family === "nix" && !scope.includes("nix-daemon"))
      throw new Error("Nix daemon did not remain in the session cgroup");
    const stopScript = `import pathlib,subprocess
group=subprocess.check_output(["systemctl","show","sealant-workspace.service","-p","ControlGroup","--value"],text=True).strip()
scope=pathlib.Path("/sys/fs/cgroup"+group)
assert "populated 1" in (scope/"cgroup.events").read_text()
subprocess.run(["systemctl","stop","sealant-workspace.service"],check=True)
try:
 events=(scope/"cgroup.events").read_text()
 print(events); assert "populated 0" in events
except FileNotFoundError:
 assert not scope.exists()
 print("cgroup removed after stop; no populated scope remains")
assert subprocess.check_output(["systemctl","show","sealant-workspace.service","-p","MainPID","--value"],text=True).strip()=="0"
subprocess.run(["systemctl","is-active","--quiet","sealant-proof-sentinel.service"],check=True)
subprocess.run(["systemctl","is-active","--quiet","sealant-proof-relay.service"],check=True)
print("outer sentinel and relay survived")
`;
    must(await api.writeFile(id, stage + "/stop.py", stopScript));
    report.afterStop = await command(id, `/usr/bin/sudo python3 '${stage}/stop.py'`);
    client.close();
    client = undefined;
    websocket.terminate();
    websocket = undefined;
    const held = JSON.stringify({ admission: "held", env: {} });
    must(await api.writeFile(id, stage + "/held.json", held));
    await command(
      id,
      `/usr/bin/sudo install -m600 '${stage}/held.json' /var/lib/sealant/control/launch.json
/usr/bin/sudo cp /var/lib/sealant/setup-marker /var/lib/sealant/setup-before-resume
/usr/bin/sudo cp /var/lib/sealant/startup-marker /var/lib/sealant/startup-before-resume`,
    );
    must(await api.stop(id));
    await poll(async () => (must(await api.get(id)).state === "archived" ? true : undefined));
    must(await api.resume(id));
    await poll(async () =>
      ["ready", "idle", "running"].includes(must(await api.get(id)).state) ? true : undefined,
    );
    report.resume = await command(
      id,
      `! /usr/bin/sudo systemctl is-active --quiet sealant-workspace.service
/usr/bin/sudo cmp /var/lib/sealant/setup-marker /var/lib/sealant/setup-before-resume
/usr/bin/sudo cmp /var/lib/sealant/startup-marker /var/lib/sealant/startup-before-resume
/usr/bin/sudo systemctl start sealant-workspace.service || true
for n in $(seq 1 90); do
  if test "$(/usr/bin/sudo systemctl show sealant-workspace.service -p MainPID --value)" = 0 && /usr/bin/sudo journalctl -u sealant-workspace.service --no-pager | grep -F 'session admission held'; then break; fi
  sleep 1
done
! /usr/bin/sudo systemctl is-active --quiet sealant-workspace.service
/usr/bin/sudo test "$(/usr/bin/sudo systemctl show sealant-workspace.service -p MainPID --value)" = 0
/usr/bin/sudo test "$(/usr/bin/sudo systemctl show sealant-workspace.service -p ExecMainStatus --value)" = 1
/usr/bin/sudo journalctl -u sealant-workspace.service --no-pager | grep -F 'session admission held'
/usr/bin/sudo cmp /var/lib/sealant/setup-marker /var/lib/sealant/setup-before-resume
/usr/bin/sudo cmp /var/lib/sealant/startup-marker /var/lib/sealant/startup-before-resume
echo admission-held-lifecycle-unchanged`,
      120,
    );
    report.result = "passed";
  }
} catch (error) {
  report.result = "failed";
  if (error instanceof NativeBuildError && error.journalPath !== undefined) {
    state.artifactJournal = error.journalPath;
    await persist();
  }
  report.error = error instanceof Error ? error.message : "unknown proof failure";
  if (state.clone?.id !== undefined && !state.clone.deleted) {
    const diagnostics = await api.execute(
      state.clone.id,
      `set -u
/usr/bin/sudo journalctl -u sealant-workspace.service -u sealant-proof-relay.service -n 100 --no-pager
/usr/bin/sudo systemctl show sealant-workspace.service -p ActiveState -p SubState -p Result -p MainPID -p ExecMainStatus -p ConditionResult
/usr/bin/sudo systemctl show sealant-proof-relay.service -p ActiveState -p SubState -p ExecMainStatus
ss -ltn 'sport = :8080'
/usr/bin/sudo sh -c 'export PATH=/usr/local/bin:/nix/var/nix/profiles/default/bin:/usr/sbin:/usr/bin:/sbin:/bin
command -v nix || true
command -v nix-daemon || true
tail -n 60 /nix/var/log/nix/nix-daemon.log 2>/dev/null || true
for pid in $(pgrep -x nix-daemon || true); do
  ps -o pid,ppid,stat,comm -p "$pid"
  readlink -f "/proc/$pid/exe" || true
  cat "/proc/$pid/cgroup" || true
done'`,
      { timeoutSeconds: 15, signal: AbortSignal.timeout(20_000) },
    );
    report.failureDiagnostics = diagnostics.ok
      ? diagnostics.value
      : { code: diagnostics.error.code, status: diagnostics.error.status };
  }
  process.exitCode = 1;
} finally {
  client?.close();
  websocket?.terminate();
  const cleanupErrors: string[] = [];
  const cleanupBound = AbortSignal.timeout(180_000);
  const cleanupRequest = async <T>(request: () => Promise<T>): Promise<T> => {
    if (cleanupBound.aborted) throw new Error("proof cleanup deadline exceeded");
    let abort: () => void = noop;
    try {
      return await Promise.race([
        request(),
        new Promise<never>((_, reject) => {
          abort = () => reject(new Error("proof cleanup deadline exceeded"));
          cleanupBound.addEventListener("abort", abort, { once: true });
          if (cleanupBound.aborted) abort();
        }),
      ]);
    } finally {
      cleanupBound.removeEventListener("abort", abort);
    }
  };
  const clone = state.clone;
  const removeClone = async () => {
    if (clone && !clone.deleted) {
      const id = clone.id ?? (await cleanupRequest(createClone));
      if (clone.deletion === undefined && clone.deletionIntent !== true) {
        const vm = must(await cleanupRequest(() => api.get(id)));
        if (
          vm.id !== id ||
          vm.labels?.["sealant-build"] !== clone.marker ||
          vm.labels["sealant-dev"] !== "boat-stream"
        )
          throw new Error("clone cleanup refused sandbox identity mismatch");
        clone.deletionIntent = true;
        await persist();
      }
      if (clone.deletion === undefined) {
        const deletion = must(await cleanupRequest(() => api.deleteSandbox(id)));
        if (deletion.targetId !== id) throw new Error("clone deletion identity mismatch");
        clone.deletion = deletion.id;
        await persist();
      }
      const deletion = clone.deletion;
      await poll(async () => {
        const result = must(await cleanupRequest(() => api.getDeletion(deletion)));
        if (result.id !== deletion || result.targetId !== id)
          throw new Error("clone deletion identity mismatch");
        return result.status === "completed" ? true : undefined;
      }, cleanupBound);
      clone.deleted = true;
      await persist();
    }
  };
  try {
    await removeClone();
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : "clone cleanup failed");
  }
  try {
    if (artifact !== undefined) {
      report.removal = must(await builder.remove(artifact));
    } else if (state.artifactJournal !== undefined) {
      must(await builder.cleanup(state.artifactJournal));
    }
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : "builder cleanup failed");
  }
  report.cleanup = { confirmed: cleanupErrors.length === 0, errors: cleanupErrors };
  if (cleanupErrors.length > 0) {
    report.result = "failed";
    process.exitCode = 1;
  }
  report.ownership = state;
  await writeFile(
    join(output, "evidence.json"),
    JSON.stringify(
      report,
      (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      family,
      result: report.result,
      evidence: join(output, "evidence.json"),
      cleanup: cleanupErrors.length === 0,
    }) + "\n",
  );
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
