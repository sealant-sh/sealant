import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ControlClient } from "./control-client.js";

const SEALANTD_BIN =
  process.env["SEALANTD_BIN"] ??
  fileURLToPath(new URL("../../../../sealantd/target/debug/sealantd", import.meta.url));
const hasSealantd = existsSync(SEALANTD_BIN);

if (process.env["REQUIRE_SEALANTD"] === "1" && !hasSealantd) {
  throw new Error(`REQUIRE_SEALANTD=1, and no sealantd at ${SEALANTD_BIN}; set SEALANTD_BIN.`);
}

let stopDaemon: (() => void) | undefined;
let socketPath = "";
let echo: Server;

beforeAll(async () => {
  if (!hasSealantd) return;
  const dir = mkdtempSync(`${tmpdir()}/sealantd-gateway-`);
  socketPath = `${dir}/control.sock`;
  const child = spawn(
    SEALANTD_BIN,
    ["--socket", socketPath, "--workspace", dir, "--log-level", "warn"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  stopDaemon = () => {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  };
  for (let attempt = 0; attempt < 400 && !existsSync(socketPath); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!existsSync(socketPath)) throw new Error("sealantd never created its control socket");
  echo = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
});

afterAll(() => {
  echo?.close();
  stopDaemon?.();
});

describe.skipIf(!hasSealantd)("ControlClient against a real sealantd", () => {
  it("opens a forward labelled with an execution id, unbound, and bridges bytes both ways", async () => {
    const address = echo.address();
    if (typeof address !== "object" || address === null) throw new Error("expected an address");
    const client = ControlClient.fromStream(connect(socketPath));
    try {
      const { result, channel } = await client.openForward(
        "127.0.0.1",
        address.port,
        "exec_gateway",
      );
      expect(result.boundSessionId).toBeUndefined();

      channel.write(new TextEncoder().encode("ssh -L"));
      channel.end();
      let echoed = "";
      for await (const chunk of channel) echoed += new TextDecoder().decode(chunk);
      expect(echoed).toBe("ssh -L");
    } finally {
      client.close();
    }
  });
});
