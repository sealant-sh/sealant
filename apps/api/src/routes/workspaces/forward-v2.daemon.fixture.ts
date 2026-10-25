import { type ChildProcess, fork, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { WorkspaceRepo, WorkspaceRuntimeInstanceRepo } from "@sealant/db";
import { SealantRuntimeLive, SealantTransport, TransportError } from "@sealant/workspaces";
import { Effect, Layer } from "effect";

/**
 * The sealantd these tests run against: `SEALANTD_BIN`, or a debug build in a `sealantd` checkout
 * beside this one. Without one the suites skip, unless `REQUIRE_SEALANTD=1`, which a job meant to
 * run them sets so that a missing binary fails instead.
 */
export const SEALANTD_BIN =
  process.env["SEALANTD_BIN"] ??
  fileURLToPath(new URL("../../../../../../sealantd/target/debug/sealantd", import.meta.url));

export const hasSealantd = existsSync(SEALANTD_BIN);

if (process.env["REQUIRE_SEALANTD"] === "1" && !hasSealantd) {
  throw new Error(`REQUIRE_SEALANTD=1, and no sealantd at ${SEALANTD_BIN}; set SEALANTD_BIN.`);
}

export interface LocalDaemon {
  readonly socketPath: string;
  readonly stop: () => void;
}

export const startSealantd = async (): Promise<LocalDaemon> => {
  const dir = mkdtempSync(`${tmpdir()}/sealantd-forward-`);
  const socketPath = `${dir}/control.sock`;
  const child = spawn(
    SEALANTD_BIN,
    ["--socket", socketPath, "--workspace", dir, "--log-level", "warn"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  for (let attempt = 0; attempt < 400 && !existsSync(socketPath); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!existsSync(socketPath)) throw new Error("sealantd never created its control socket");
  return {
    socketPath,
    stop: () => {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

export const LIVE_OWNER = "usr_forward_live";
export const LIVE_WORKSPACE = "wks_live";

export const liveDaemonServices = (daemon: LocalDaemon) =>
  Layer.mergeAll(
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: (id: string) =>
        Effect.succeed(
          id === LIVE_WORKSPACE
            ? { id, ownerUserId: LIVE_OWNER, latestRunId: "run_live" }
            : undefined,
        ),
    } as never),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: (runId: string) =>
        Effect.succeed({
          runId,
          status: "ready",
          adapter: "docker",
          resourceId: "ctr_live",
          reference: "ctr",
          endpoint: null,
        }),
    } as never),
    SealantRuntimeLive.pipe(
      Layer.provide(
        Layer.succeed(SealantTransport, {
          open: () =>
            Effect.acquireRelease(
              Effect.callback<ReturnType<typeof connect>, TransportError>((resume) => {
                const socket = connect(daemon.socketPath);
                socket.once("connect", () => resume(Effect.succeed(socket)));
                socket.once("error", (cause) =>
                  resume(
                    Effect.fail(
                      new TransportError({ operation: "open", message: cause.message, cause }),
                    ),
                  ),
                );
              }),
              (socket) => Effect.sync(() => socket.destroy()),
            ),
        }),
      ),
    ),
  );

export interface TargetProcess {
  readonly port: number;
  readonly latest: () => TargetReport;
  readonly finished: Promise<TargetReport>;
  readonly connectionClosed: Promise<void>;
  readonly send: (message: TargetCommand) => void;
  readonly stop: () => void;
}

export interface TargetReport {
  readonly bytes: number;
  readonly sha256?: string;
  readonly closed?: true;
}

export type TargetCommand = "pace" | "drain";

const TARGETS = fileURLToPath(new URL("./forward-v2.daemon.targets.mjs", import.meta.url));

export type Target =
  | { readonly mode: "produce"; readonly bytes: number }
  | { readonly mode: "sink" }
  | { readonly mode: "echo" };

export const startTarget = (target: Target): Promise<TargetProcess> =>
  new Promise((resolve, reject) => {
    const args = target.mode === "produce" ? [target.mode, String(target.bytes)] : [target.mode];
    const child: ChildProcess = fork(TARGETS, args, {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let latest: TargetReport = { bytes: 0 };
    const finished = Promise.withResolvers<TargetReport>();
    const connectionClosed = Promise.withResolvers<void>();
    child.on("message", (message: { readonly port?: number } & TargetReport) => {
      if (message.port !== undefined) {
        return resolve({
          port: message.port,
          latest: () => latest,
          finished: finished.promise,
          connectionClosed: connectionClosed.promise,
          send: (command) => child.send(command),
          stop: () => child.kill("SIGKILL"),
        });
      }
      if (message.closed === true) return connectionClosed.resolve();
      latest = message;
      if (message.sha256 !== undefined) finished.resolve(message);
    });
    child.once("error", reject);
  });

const gcFunction: unknown = (() => {
  setFlagsFromString("--expose-gc");
  return runInNewContext("gc");
})();

/**
 * `process.memoryUsage().arrayBuffers` after two full collections: what is still held. After one,
 * the count can still include tens of MiB of buffers that died just before it.
 */
export const heldArrayBuffers = (): number => {
  if (typeof gcFunction !== "function") throw new Error("gc is not exposed");
  gcFunction();
  gcFunction();
  return process.memoryUsage().arrayBuffers;
};

const PROC_NET_TCP = { localAddress: 1, remoteAddress: 2, state: 3, queues: 4 } as const;
const TCP_ESTABLISHED = "01";
const TCP_SYN_SENT = "02";

const tcpSockets = () =>
  ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length > PROC_NET_TCP.queues),
  );

const portOf = (address: string | undefined) => Number.parseInt(address?.split(":")[1] ?? "", 16);

export const synSentRemotePorts = (): number[] =>
  tcpSockets()
    .filter((fields) => fields[PROC_NET_TCP.state] === TCP_SYN_SENT)
    .map((fields) => portOf(fields[PROC_NET_TCP.remoteAddress]));

export const tcpQueuedBytes = (port: number): number =>
  tcpSockets()
    .filter(
      (fields) =>
        fields[PROC_NET_TCP.state] === TCP_ESTABLISHED &&
        (portOf(fields[PROC_NET_TCP.localAddress]) === port ||
          portOf(fields[PROC_NET_TCP.remoteAddress]) === port),
    )
    .reduce((sum, fields) => {
      const [tx = "0", rx = "0"] = fields[PROC_NET_TCP.queues]?.split(":") ?? [];
      return sum + Number.parseInt(tx, 16) + Number.parseInt(rx, 16);
    }, 0);

export const defaultSendBufferBytes = (): number =>
  Number(readFileSync("/proc/sys/net/core/wmem_default", "utf8").trim());
