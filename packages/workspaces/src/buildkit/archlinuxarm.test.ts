/**
 * The rootfs fetch, run as the build runs it (bash, curl) against local mirrors: one the
 * redirector sends every request to and that serves a trickle, one whose tarball does not match
 * its signature, and a fast one. `gpg` is a stand-in that accepts a signature holding the
 * tarball's sha256, so the test needs no keyring.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { renderArchlinuxArmFetch, type ArchlinuxArmFetchOptions } from "./archlinuxarm.js";

const FILE = "/os/ArchLinuxARM-aarch64-latest.tar.gz";
const tarball = Buffer.alloc(64 * 1024, "alarm");
const signatureOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

interface Request {
  readonly mirror: string;
  readonly method: string;
  readonly path: string;
  readonly range: string | undefined;
}

let server: Server;
let base = "";
let requests: Request[] = [];
let work = "";

/** A mirror at `/<name>`: `slow` sends 2 KB every 100 ms, `bad` a tarball its signature is not for. */
const serve = (request: IncomingMessage, response: ServerResponse): void => {
  const [, mirror = "", ...rest] = (request.url ?? "").split("/");
  const path = `/${rest.join("/")}`;
  requests.push({ mirror, method: request.method ?? "", path, range: request.headers.range });
  if (mirror === "redirector") {
    response.writeHead(302, { location: `${base}/slow${path}` }).end();
    return;
  }
  const body = mirror === "bad" ? Buffer.alloc(tarball.length, "other") : tarball;
  if (path === `${FILE}.sig`) {
    response.writeHead(200).end(signatureOf(tarball));
    return;
  }
  if (path !== FILE || !["slow", "bad", "fast"].includes(mirror)) {
    response.writeHead(404).end();
    return;
  }
  const start = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1] ?? 0);
  const headers = { "content-length": String(body.length - start) };
  if (request.method === "HEAD") {
    response.writeHead(200, { "content-length": String(body.length) }).end();
    return;
  }
  response.writeHead(
    start === 0 ? 200 : 206,
    start === 0
      ? headers
      : { ...headers, "content-range": `bytes ${start}-${body.length - 1}/${body.length}` },
  );
  if (mirror !== "slow") {
    response.end(body.subarray(start));
    return;
  }
  let offset = start;
  const timer = setInterval(() => {
    if (offset >= body.length || response.destroyed) {
      clearInterval(timer);
      response.end();
      return;
    }
    response.write(body.subarray(offset, offset + 2048));
    offset += 2048;
  }, 100);
  response.on("close", () => clearInterval(timer));
};

const run = (
  options: Partial<ArchlinuxArmFetchOptions>,
): Promise<{ readonly code: number; readonly output: string }> =>
  new Promise((resolve) => {
    const script = renderArchlinuxArmFetch({
      cache: join(work, "cache"),
      floor: 100 * 1024,
      slowFloor: 1,
      window: 1,
      tick: 1,
      ...options,
    });
    execFile(
      "bash",
      ["-c", `set -eu\n${script}`],
      { env: { ...process.env, PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}` } },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : Number(error.code ?? 1), output: stdout + stderr });
      },
    );
  });

const cached = (name: string): Promise<Buffer> => readFile(join(work, "cache", name));

beforeAll(async () => {
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port to serve on");
  base = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  requests = [];
  work = await mkdtemp(join(tmpdir(), "sealant-archlinuxarm-"));
  await mkdir(join(work, "bin"));
  // gpg --batch --verify <signature> <file>
  await writeFile(
    join(work, "bin", "gpg"),
    '#!/usr/bin/env bash\n[ "$(sha256sum < "${@: -1}" | cut -d" " -f1)" = "$(cat "${@: -2:1}")" ]\n',
  );
  await chmod(join(work, "bin", "gpg"), 0o755);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("fetching the Arch Linux ARM rootfs", () => {
  it("leaves a mirror the redirector picks when it falls below the floor, and resumes on the next", async () => {
    const { code, output } = await run({
      sources: [`${base}/redirector`, `${base}/redirector`, `${base}/bad`, `${base}/fast`],
    });

    expect(code, output).toBe(0);
    expect(await cached("rootfs.tar.gz")).toEqual(tarball);
    // The redirector's mirror was given up below the floor, after printing how far it got.
    expect(output).toMatch(
      new RegExp(`${base}/slow${FILE} stopped at \\d+ MiB \\(curl exit 28\\)`),
    );
    expect(output).toMatch(/archlinuxarm: \d+ MiB of 0 MiB/);
    // The redirector's second answer was the same mirror: not tried again on this pass.
    expect(output).toContain(`${base}/slow${FILE} was already tried on this pass`);
    expect(output).toContain(`the tarball from ${base}/bad${FILE} does not match its signature`);
    // The bad mirror's tarball was thrown away, so the fast mirror started from the beginning.
    const fast = requests.filter(
      (request) => request.mirror === "fast" && request.method === "GET",
    );
    expect(fast.find((request) => request.path === FILE)?.range).toBeUndefined();
  });

  it("resumes a partial download from another mirror while the signature is the same", async () => {
    const { code, output } = await run({ sources: [`${base}/slow`, `${base}/fast`] });

    expect(code, output).toBe(0);
    expect(await cached("rootfs.tar.gz")).toEqual(tarball);
    const resumed = requests.find(
      (request) => request.mirror === "fast" && request.method === "GET" && request.path === FILE,
    );
    expect(resumed?.range).toMatch(/^bytes=[1-9]\d*-$/);
  });

  it("finishes on a link that is slow everywhere on the second pass, which only needs bytes to arrive", async () => {
    const { code, output } = await run({ sources: [`${base}/slow`] });

    expect(code, output).toBe(0);
    expect(output).toContain("stopped at");
    expect(await cached("rootfs.tar.gz")).toEqual(tarball);
  }, 30_000);

  it("reuses the cached tarball while it verifies against the current signature", async () => {
    expect((await run({ sources: [`${base}/fast`] })).code).toBe(0);
    requests = [];

    const { code, output } = await run({ sources: [`${base}/fast`] });

    expect(code, output).toBe(0);
    expect(output).toContain("the cached rootfs is the current one");
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `HEAD ${FILE}`,
      `GET ${FILE}.sig`,
    ]);
  });

  it("fails the build when no source delivers a tarball that verifies", async () => {
    const { code, output } = await run({ sources: [`${base}/bad`, `${base}/missing`] });

    expect(code).toBe(1);
    expect(output).toContain(`${base}/missing${FILE} did not answer`);
    expect(output).toContain("no source delivered a rootfs that verifies");
    await expect(cached("rootfs.tar.gz")).rejects.toThrow();
  });
});
