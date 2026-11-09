import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { expect, it } from "vitest";

import { SealantRuntime, SealantRuntimeControlLive } from "../../sealantd/runtime.js";
import { BoatSecret } from "./config.js";
import { createBoatGuestTransport } from "./execution.js";

const secret = (value: string) => {
  const parsed = BoatSecret.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
};
const unused = async (): Promise<never> => {
  throw new Error("readiness proof must not contact provider");
};
/**
 * Stands in for guest_control.py's bridge: one verdict line, then the daemon's bytes. The guest's
 * peer rule itself is proven against real sealantd in boat-image/control_daemon_proof.py.
 */
const line = (fields: Record<string, string>) =>
  `${JSON.stringify({ format: "sealant-control-bridge-v1", ...fields })}\n`;
const bridge = async (path: string, daemonSocket: string, refusal?: string) => {
  const server = net.createServer((client) => {
    client.on("error", () => undefined);
    if (refusal !== undefined) {
      client.end(line({ error: refusal }));
      return;
    }
    const upstream = net.createConnection(daemonSocket, () => {
      client.write(line({ control: "connected" }));
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return server;
};

it("authenticated relay round-trips real pinned daemon health and capabilities, refusing a wrong bearer", async () => {
  const binary = process.env.SEALANTD_BIN;
  if (binary === undefined)
    throw new Error("SEALANTD_BIN must name the pinned daemon for the Boat readiness proof");
  const directory = await mkdtemp(join(tmpdir(), "boat-readiness-control-"));
  const socket = join(directory, "control.sock");
  const token = secret("a".repeat(64));
  const tokenFile = join(directory, "relay.token");
  await writeFile(tokenFile, token.reveal(), { mode: 0o600 });
  const daemon = spawn(
    binary,
    ["--socket", socket, "--workspace", directory, "--log-level", "warn"],
    { stdio: "ignore" },
  );
  let relay: ChildProcess | undefined;
  const bridges: net.Server[] = [];
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(existsSync(socket)).toBe(true);
    const port = net.createServer();
    await new Promise<void>((resolve) => port.listen(0, "127.0.0.1", resolve));
    const address = port.address();
    if (address === null || typeof address === "string") throw new Error("missing proof port");
    await new Promise<void>((resolve) => port.close(() => resolve()));
    const bridged = join(directory, "bridge.sock");
    bridges.push(await bridge(bridged, socket));
    relay = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../../boat-image/control-relay.mjs", import.meta.url)),
        "--socket",
        bridged,
        "--token-file",
        tokenFile,
        "--port",
        String(address.port),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    relay.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    for (let attempt = 0; attempt < 100 && !output.includes("Relay listening"); attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(output).toContain("Relay listening");
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const transport = createBoatGuestTransport(
          { get: unused, execute: unused, hostControl: unused },
          runtime,
        );
        // Loopback ws exercises the same framing/auth path; provider HTTPS is deliberately absent.
        const access = {
          origin: `http://127.0.0.1:${address.port}`,
          cookie: secret("local-cookie-only"),
        };
        const ready = yield* Effect.promise(() => transport.probe(access, token));
        expect(ready.healthy).toBe(true);
        expect(ready.runtimeId).toMatch(/^rt_/);
        expect(ready.supports).toEqual(
          expect.arrayContaining([
            "exec.user",
            "dotfiles.user",
            "restore.owner_map",
            "process.secret-env.v1",
          ]),
        );
        yield* Effect.promise(() =>
          expect(transport.probe(access, secret("b".repeat(64)))).rejects.toBeDefined(),
        );
      }).pipe(Effect.provide(SealantRuntimeControlLive)),
    );
  } finally {
    if (relay !== undefined) await stop(relay);
    for (const server of bridges)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await stop(daemon);
    console.log({ ownedScratch: directory, entries: await readdir(directory) });
    await rm(directory, { recursive: true });
    expect(existsSync(directory)).toBe(false);
  }
});
