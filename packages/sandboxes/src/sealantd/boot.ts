/**
 * Shared boot helper for the Docker-backed sealantd e2e specs (extracted from the P3 `proof.e2e.ts`
 * flow). Boots the baked sandbox image so its real entrypoint launches `sealantd` on a control
 * socket, then exposes the container id + socket path for a transport to bridge into.
 *
 * Kept out of the default unit run: only the `*.e2e.ts` specs (run via `test:e2e`) import it, and
 * they require Docker + the prebuilt image.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Image produced by the P3-Build phase (Fedora + sealantd baked in). */
export const DEFAULT_IMAGE_REF = "sealant-sandbox-fedora-claude-code:claude-code";
/** Control socket path the entrypoint launches sealantd on (matches renderSandboxEntrypoint). */
export const DEFAULT_CONTROL_SOCKET = "/run/sealant/control.sock";
/** Resolved `workingDirectory` default; the entrypoint checks `<this>/.git` to decide whether to clone. */
export const DEFAULT_WORKING_DIRECTORY = "/sandbox/repo";

/** Run `docker <args>`, resolving with trimmed stdout or rejecting with stderr. */
export const docker = (args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`docker ${args.join(" ")} exited ${code ?? "?"}: ${stderr.trim()}`));
      }
    });
  });

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns true when the baked image is present locally (used to skip e2e specs gracefully). */
export const isImagePresent = async (imageRef = DEFAULT_IMAGE_REF): Promise<boolean> => {
  try {
    await docker(["image", "inspect", imageRef, "--format", "{{.Id}}"]);
    return true;
  } catch {
    return false;
  }
};

export interface BootedSealantd {
  /** Container id of the booted sandbox. */
  readonly containerId: string;
  /** In-container control socket path sealantd is listening on. */
  readonly socketPath: string;
  /** Tears down the container and removes the host workspace mount. */
  readonly teardown: () => Promise<void>;
}

/**
 * Boots the baked image via its REAL entrypoint so `sealantd` runs in the background, then waits for
 * the control socket to appear. A host dir with a `.git/` marker is bind-mounted at the working
 * directory so the entrypoint skips its clone (no network, no real repo); the foreground is replaced
 * with `sleep infinity` to keep the container alive.
 */
export const bootSealantdContainer = async (
  options: {
    readonly imageRef?: string;
    readonly socketPath?: string;
    readonly workingDirectory?: string;
  } = {},
): Promise<BootedSealantd> => {
  const imageRef = options.imageRef ?? DEFAULT_IMAGE_REF;
  const socketPath = options.socketPath ?? DEFAULT_CONTROL_SOCKET;
  const workingDirectory = options.workingDirectory ?? DEFAULT_WORKING_DIRECTORY;

  const workspaceMount = mkdtempSync(join(tmpdir(), "sealantd-e2e-"));
  mkdirSync(join(workspaceMount, ".git"));

  const containerId = await docker([
    "run",
    "-d",
    "--rm",
    "-e",
    "SEALANT_FOREGROUND_COMMAND=sleep infinity",
    "-v",
    `${workspaceMount}:${workingDirectory}`,
    imageRef,
  ]);

  const teardown = async (): Promise<void> => {
    await docker(["rm", "-f", containerId]).catch(() => {});
    rmSync(workspaceMount, { recursive: true, force: true });
  };

  let socketReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await docker(["exec", containerId, "test", "-S", socketPath]);
      socketReady = true;
      break;
    } catch {
      await delay(100);
    }
  }

  if (!socketReady) {
    const logs = await docker(["logs", containerId]).catch(() => "(no logs)");
    await teardown();
    throw new Error(`sealantd control socket never appeared. Entrypoint logs:\n${logs}`);
  }

  return { containerId, socketPath, teardown };
};
