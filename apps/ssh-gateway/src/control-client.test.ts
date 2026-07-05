// Unit tests for the gateway's ControlClient channel->command glue (gateway-spec §3.1/§3.3). No
// docker, no daemon: an in-memory `FakeDaemon` Duplex decodes the ClientMessages the ControlClient
// emits and replies with the matching ServerMessage responses + stream frames, so we can assert that
// each high-level operation issues the right command and bridges the right byte channel.

import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";

import { fromBinary } from "@bufbuild/protobuf";
import {
  create,
  encodeServer,
  encodeFrame,
  ClientMessageSchema,
  ServerMessageSchema,
  type ClientMessage,
} from "@sealant/runtime-protocol";
import { describe, expect, it } from "vitest";

import { ControlClient } from "./control-client.js";

// A FrameDecoder for ClientMessages (the SDK's decoder is ServerMessage-only). Mirrors its framing.
class ClientFrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): ClientMessage[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const out: ClientMessage[] = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (this.#buffer.length < 4 + length) break;
      out.push(fromBinary(ClientMessageSchema, this.#buffer.subarray(4, 4 + length)));
      this.#buffer = this.#buffer.subarray(4 + length);
    }
    return out;
  }
}

/** Records the commands it received and replies with canned ok-results + optional stream frames. */
class FakeDaemon extends Duplex {
  readonly commands: Array<{ requestId: string; case: string; value: unknown }> = [];
  readonly streamFramesOut: ClientMessage[] = [];
  #decoder = new ClientFrameDecoder();
  #channelCounter = 0;

  _read(): void {}

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    for (const message of this.#decoder.push(Buffer.from(chunk))) {
      if (message.message.case === "request") {
        const req = message.message.value;
        const command = req.command?.command;
        this.commands.push({
          requestId: req.requestId,
          case: command?.case ?? "unknown",
          value: command?.value,
        });
        this.#handleRequest(req.requestId, command?.case, command?.value);
      } else if (message.message.case === "stream") {
        this.streamFramesOut.push(message);
      }
    }
    cb();
  }

  #send(message: Parameters<typeof encodeServer>[0]): void {
    this.push(encodeFrame(encodeServer(message)));
  }

  #okResult(requestId: string, result: { result: { case: string; value: unknown } }): void {
    this.#send(
      create(ServerMessageSchema, {
        message: {
          case: "response",
          value: {
            schemaVersion: 1,
            requestId,
            // The CommandResult oneof init is validated by the schema at create()-time.
            outcome: { outcome: { case: "ok", value: result as never } },
          },
        },
      }),
    );
  }

  #handleRequest(requestId: string, kase: string | undefined, _value: unknown): void {
    switch (kase) {
      case "openSession": {
        this.#okResult(requestId, {
          result: {
            case: "sessionOpened",
            value: { sessionId: "sess-1", processId: "proc-1", pid: 100 },
          },
        });
        break;
      }
      case "attachSession": {
        const channelId = `chan-${++this.#channelCounter}`;
        this.lastChannelId = channelId;
        this.#okResult(requestId, {
          result: { case: "streamAttached", value: { channelId } },
        });
        break;
      }
      case "exec": {
        const channelId = `chan-${++this.#channelCounter}`;
        this.lastChannelId = channelId;
        this.#okResult(requestId, {
          result: {
            case: "processAttached",
            value: { processId: "proc-2", pid: 200, pgid: 200, channelId },
          },
        });
        break;
      }
      case "openForward": {
        const channelId = `chan-${++this.#channelCounter}`;
        this.lastChannelId = channelId;
        this.#okResult(requestId, {
          result: { case: "forwardOpened", value: { channelId } },
        });
        break;
      }
      case "openSftp": {
        const channelId = `chan-${++this.#channelCounter}`;
        this.lastChannelId = channelId;
        this.#okResult(requestId, {
          result: { case: "sftpOpened", value: { channelId } },
        });
        break;
      }
      case "resizePty":
      case "closeSession":
      case "signalProcess":
      case "writeStdin": {
        // Accepted (Empty) result.
        this.#okResult(requestId, { result: { case: "accepted", value: {} } });
        break;
      }
      default: {
        this.#okResult(requestId, { result: { case: "accepted", value: {} } });
      }
    }
  }

  lastChannelId: string | undefined;

  /** Push a daemon->client data frame on `channelId`. */
  emitData(channelId: string, bytes: number[]): void {
    this.#send(
      create(ServerMessageSchema, {
        message: {
          case: "stream",
          value: { channelId, seq: 0n, payload: { case: "data", value: new Uint8Array(bytes) } },
        },
      }),
    );
  }

  /** Push a daemon->client End frame on `channelId`. */
  emitEnd(channelId: string, exitCode?: number): void {
    this.#send(
      create(ServerMessageSchema, {
        message: {
          case: "stream",
          value: { channelId, seq: 1n, payload: { case: "end", value: { exitCode } } },
        },
      }),
    );
  }
}

const lastCommand = (daemon: FakeDaemon) => daemon.commands[daemon.commands.length - 1];

describe("ControlClient channel->command mapping", () => {
  it("openShell issues openSession{login} then attachSession{interactive} and streams PTY bytes", async () => {
    const daemon = new FakeDaemon();
    const client = ControlClient.fromStream(daemon);

    const shell = await client.openShell({
      cols: 120,
      rows: 40,
      term: "xterm",
      env: { TERM: "xterm" },
    });

    const openSession = daemon.commands.find((c) => c.case === "openSession");
    expect(openSession?.value).toMatchObject({
      shell: "/bin/bash",
      args: ["-l"],
      cols: 120,
      rows: 40,
    });
    expect(daemon.commands.find((c) => c.case === "attachSession")?.value).toMatchObject({
      mode: 1,
    });
    expect(shell.sessionId).toBe("sess-1");
    expect(shell.processId).toBe("proc-1");

    // PTY output rides the attached channel inbound.
    const chunks: Uint8Array[] = [];
    const drain = (async () => {
      for await (const chunk of shell.channel) {
        chunks.push(chunk);
      }
    })();
    daemon.emitData(shell.channel.channelId, [0x68, 0x69]); // "hi"
    daemon.emitEnd(shell.channel.channelId, 0);
    await drain;
    expect(chunks.map((c) => [...c])).toEqual([[0x68, 0x69]]);

    client.close();
  });

  it("writeSessionInput / resizePty / signalProcess map to writeStdin / resizePty / signalProcess", async () => {
    const daemon = new FakeDaemon();
    const client = ControlClient.fromStream(daemon);

    await client.writeSessionInput("sess-1", new Uint8Array([0x03]));
    // Interactive PTY input must route by *sessionId*, not processId: the daemon's WriteStdinArgs is
    // an exclusive choice and the session path is what delivers SSH keystrokes to a live PTY.
    const writeStdin = lastCommand(daemon);
    expect(writeStdin).toBeDefined();
    expect(writeStdin).toMatchObject({ case: "writeStdin", value: { sessionId: "sess-1" } });
    const writeStdinValue = writeStdin?.value as { processId?: string; sessionId?: string };
    expect(writeStdinValue.processId).toBeUndefined();
    expect(writeStdinValue.sessionId).toBe("sess-1");

    await client.resizePty("sess-1", 100, 30);
    expect(lastCommand(daemon)).toMatchObject({
      case: "resizePty",
      value: { sessionId: "sess-1", cols: 100, rows: 30 },
    });

    await client.signalProcess("proc-1", 2);
    expect(lastCommand(daemon)).toMatchObject({
      case: "signalProcess",
      value: { processId: "proc-1", signal: 2 },
    });

    client.close();
  });

  it("execLogin issues exec{/bin/bash -lc, attach:true} and exposes its byte channel", async () => {
    const daemon = new FakeDaemon();
    const client = ControlClient.fromStream(daemon);

    const exec = await client.execLogin({ command: "exit 7", env: {} });
    expect(lastCommand(daemon)).toMatchObject({
      case: "exec",
      value: { executable: "/bin/bash", args: ["-lc", "exit 7"], attach: true, stdin: true },
    });
    expect(exec.processId).toBe("proc-2");

    // exit code surfaces via the channel's remote End.
    daemon.emitEnd(exec.channel.channelId, 7);
    const cause = await exec.channel.closed;
    expect(cause.kind).toBe("remote");
    if (cause.kind === "remote") expect(cause.end.exitCode).toBe(7);

    client.close();
  });

  it("openForward issues openForward{host,port} and bridges bytes both ways", async () => {
    const daemon = new FakeDaemon();
    const client = ControlClient.fromStream(daemon);

    const { result, channel } = await client.openForward("127.0.0.1", 9000);
    expect(lastCommand(daemon)).toMatchObject({
      case: "openForward",
      value: { host: "127.0.0.1", port: 9000 },
    });
    expect(result.channelId).toBe(channel.channelId);

    // Outbound: a write muxes a ClientMessage::Stream for this channel.
    channel.write(new Uint8Array([0x47, 0x45, 0x54])); // "GET"
    await new Promise((r) => setImmediate(r));
    const outbound = daemon.streamFramesOut.at(-1);
    expect(outbound?.message.case).toBe("stream");

    // Inbound: a daemon data frame arrives on the channel.
    const chunks: Uint8Array[] = [];
    const drain = (async () => {
      for await (const chunk of channel) chunks.push(chunk);
    })();
    daemon.emitData(channel.channelId, [0x4f, 0x4b]); // "OK"
    daemon.emitEnd(channel.channelId);
    await drain;
    expect(chunks.map((c) => [...c])).toEqual([[0x4f, 0x4b]]);

    client.close();
  });

  it("openSftp issues openSftp and returns a byte channel", async () => {
    const daemon = new FakeDaemon();
    const client = ControlClient.fromStream(daemon);

    const { channel } = await client.openSftp();
    expect(lastCommand(daemon)).toMatchObject({ case: "openSftp" });
    expect(channel.channelId).toBe(daemon.lastChannelId);

    client.close();
  });
});
