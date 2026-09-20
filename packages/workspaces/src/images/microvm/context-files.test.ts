import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadMicrovmContextFiles, MicrovmContextFilesError } from "./context-files.js";
import { MICROVM_AGENT_FILES, MICROVM_ARCH_FILES, MICROVM_DOCKER_FILES } from "./recipe.js";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadMicrovmContextFiles", () => {
  it("reads the package's own files from source", async () => {
    const { read, digest } = await loadMicrovmContextFiles();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    for (const file of [...MICROVM_AGENT_FILES, ...MICROVM_DOCKER_FILES, ...MICROVM_ARCH_FILES]) {
      expect((await read(file)).byteLength).toBeGreaterThan(0);
    }
  });

  it("reads them from beside dist/ in a bundled worker image", async () => {
    const app = await mkdtemp(path.join(tmpdir(), "sealant-microvm-context-"));
    scratch.push(app);
    await mkdir(path.join(app, "dist"));
    await mkdir(path.join(app, "microvm-image"));
    for (const file of [...MICROVM_AGENT_FILES, ...MICROVM_DOCKER_FILES, ...MICROVM_ARCH_FILES]) {
      await writeFile(path.join(app, "microvm-image", file), `// ${file}\n`);
    }

    const moduleUrl = pathToFileURL(path.join(app, "dist", "index.js")).href;
    const files = await loadMicrovmContextFiles({ moduleUrl });

    expect(Buffer.from(await files.read("agent.mjs")).toString()).toBe("// agent.mjs\n");

    // A release that changes the agent has a different digest, so it builds new images.
    await writeFile(path.join(app, "microvm-image", "agent.mjs"), "// agent.mjs, changed\n");
    expect((await loadMicrovmContextFiles({ moduleUrl })).digest).not.toBe(files.digest);
  });

  it("stops at start when a release did not ship them, naming the files", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "sealant-microvm-context-"));
    scratch.push(empty);
    await writeFile(path.join(empty, "agent.mjs"), "");

    await expect(loadMicrovmContextFiles({ directory: empty })).rejects.toThrow(
      MicrovmContextFilesError,
    );
    await expect(loadMicrovmContextFiles({ directory: empty })).rejects.toThrow(
      /download-docker\.sh/,
    );
  });
});
