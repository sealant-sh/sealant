/**
 * Puts a launch's files in place before `sealantd boot`: the secret env file, credential files and
 * dotfiles. Each file's bytes go through the sandbox's file API into a root-only staging directory,
 * and a command that carries only paths and a mode puts it in place and removes the staged copy. No
 * process ever holds a file's bytes in its arguments or environment, where `/proc` shows them and
 * where Linux caps one string at 128 KiB (which a dotfiles archive can exceed).
 */
import type { BridgeLaunchRequest } from "@sealant/workspaces/cloudflare/bridge-contract";

import { INSTALL_STAGED_SCRIPT, PREPARE_STAGING_SCRIPT, stagedWritesForLaunch } from "./plan.js";

/** What staging needs of a sandbox (the SDK's `getSandbox` stub has it). */
export interface StagingSandbox {
  exec(
    command: readonly [string, ...string[]],
    options?: { readonly env?: Record<string, string> },
  ): Promise<{ waitForExit(): Promise<{ readonly code: number }> }>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<unknown>;
  deleteFile(path: string): Promise<unknown>;
}

/** Run a short foreground command and return its exit code. */
export const execExit = async (
  sandbox: Pick<StagingSandbox, "exec">,
  command: readonly [string, ...string[]],
  env?: Record<string, string>,
): Promise<number> => {
  const handle = await sandbox.exec(command, env === undefined ? {} : { env });
  const exit = await handle.waitForExit();
  return exit.code;
};

export const stageLaunchFiles = async (
  sandbox: StagingSandbox,
  request: BridgeLaunchRequest,
): Promise<void> => {
  const writes = stagedWritesForLaunch(request);
  if (writes.length === 0) return;
  const prepared = await execExit(sandbox, ["/bin/sh", "-c", PREPARE_STAGING_SCRIPT]);
  if (prepared !== 0) {
    throw new Error(`staging a workspace file failed: no staging directory (exit ${prepared})`);
  }
  for (const write of writes) {
    try {
      await sandbox.writeFile(write.stagingPath, write.content, { encoding: write.encoding });
    } catch (cause) {
      await sandbox.deleteFile(write.stagingPath).catch(() => undefined);
      throw cause;
    }
    const exitCode = await execExit(sandbox, ["/bin/sh", "-c", INSTALL_STAGED_SCRIPT], {
      ...write.env,
    });
    if (exitCode !== 0) {
      throw new Error(
        `staging a workspace file failed: ${write.env["SEALANT_WRITE_PATH"] ?? "?"} (exit ${exitCode})`,
      );
    }
  }
};
