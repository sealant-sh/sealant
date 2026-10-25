import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const [mode, ...modeArgs] = process.argv.slice(2);
const [totalArg] = modeArgs;
const CHUNK = 64 * 1024;
const PACE_BYTES_PER_TICK = 100 * 1024;

const report = (message) => process.send?.(message);

const produce = (socket) => {
  const total = Number(totalArg);
  const block = randomBytes(CHUNK);
  const hash = createHash("sha256");
  let index = 0;
  const reporting = setInterval(() => report({ bytes: socket.bytesWritten }), 50);
  const next = () => {
    while (index * CHUNK < total) {
      const chunk = Buffer.from(block);
      chunk.writeUInt32BE(index, 0);
      index += 1;
      hash.update(chunk);
      if (!socket.write(chunk)) return socket.once("drain", next);
    }
    socket.end(() => {
      clearInterval(reporting);
      report({ bytes: socket.bytesWritten, sha256: hash.digest("hex") });
    });
  };
  next();
};

const burst = (socket) => {
  socket.write(randomBytes(Number(totalArg)));
};

const sink = (socket) => {
  const hash = createHash("sha256");
  let bytes = 0;
  let budget = 0;
  let pacing;
  socket.pause();
  socket.on("data", (data) => {
    bytes += data.byteLength;
    hash.update(data);
    if (pacing !== undefined) {
      budget -= data.byteLength;
      if (budget <= 0) socket.pause();
    }
  });
  const reporting = setInterval(() => report({ bytes }), 50);
  process.on("message", (command) => {
    clearInterval(pacing);
    pacing = undefined;
    if (command === "drain") return socket.resume();
    pacing = setInterval(() => {
      budget = PACE_BYTES_PER_TICK;
      socket.resume();
    }, 100);
  });
  socket.on("end", () => {
    clearInterval(reporting);
    clearInterval(pacing);
    report({ bytes, sha256: hash.digest("hex") });
    socket.end();
  });
};

const echo = (socket) => {
  const hash = createHash("sha256");
  let bytes = 0;
  socket.on("data", (data) => {
    bytes += data.byteLength;
    hash.update(data);
  });
  socket.on("end", () => report({ bytes, sha256: hash.digest("hex") }));
  socket.on("close", () => report({ bytes, closed: true }));
  socket.pipe(socket);
};

if (mode === "detached") {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...modeArgs], {
    detached: true,
    stdio: "ignore",
  });
  writeFileSync(process.env.TARGET_PIDFILE, String(child.pid));
  setInterval(() => {}, 60_000);
} else {
  const serve = { produce, burst, sink, echo }[mode];
  if (serve === undefined) throw new Error(`unknown mode ${mode}`);
  const server = createServer((socket) => {
    socket.on("error", () => {});
    serve(socket);
  });
  server.listen(Number(process.env.TARGET_PORT ?? 0), "127.0.0.1", () => {
    const { port } = server.address();
    if (process.env.TARGET_PORTFILE !== undefined) {
      writeFileSync(`${process.env.TARGET_PORTFILE}.tmp`, String(port));
      renameSync(`${process.env.TARGET_PORTFILE}.tmp`, process.env.TARGET_PORTFILE);
    }
    report({ port });
  });
  process.on("disconnect", () => process.exit(0));
}
