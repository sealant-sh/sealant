import { z } from "zod";

/*
Interactive-run recording (the consolidated run model: a run is a recorded session of work in a
workspace by ANY actor, human or harness).

One SSH client connection = one run. The gateway registers the run before the first daemon channel
opens, threads its id through the daemon as the execution id (so the ingester attributes the
session's telemetry to it), and on disconnect captures the working-tree diff and marks the run
completed. Recording is BEST-EFFORT by design: an API hiccup must never block SSH access — failures
log loudly and the session proceeds unrecorded.

Known, accepted gaps (v1):
- Concurrent runs share one working tree, so the end-of-session diff is only crisp when runs do not
  overlap — same caveat as harness runs.
- If the gateway dies mid-session the run stays "running" (no reaper yet).
*/

const createRunResponseSchema = z.object({ runId: z.string().trim().min(1) });

/** Matches the run-exec worker's capture; the workspace repo checkout path baked into the image. */
const REPO_WORKDIR = "/workspace/repo";

/** The internal harness id recorded for human SSH sessions (no harness runs; a person does). */
export const SSH_HARNESS_ID = "ssh";

export interface RunRecorderConfig {
  readonly apiBaseUrl: string;
}

export interface FileChange {
  readonly path: string;
  readonly change: "added" | "modified" | "deleted" | "renamed";
}

/** Parse `git diff --name-status` output into the wire change list (mirrors the run-exec worker). */
export const parseNameStatus = (output: string): FileChange[] => {
  const files: FileChange[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const code = parts[0] ?? "";
    const change: FileChange["change"] = code.startsWith("A")
      ? "added"
      : code.startsWith("D")
        ? "deleted"
        : code.startsWith("R")
          ? "renamed"
          : "modified";
    const path = parts.slice(1).join(" ");
    if (path.length > 0) {
      files.push({ path, change });
    }
  }
  return files;
};

const postJson = async (
  url: URL,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<{ ok: boolean; status: number; payload: unknown }> => {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
};

/**
 * Register the interactive run for an SSH connection and mark it running. Returns undefined when
 * recording is unavailable (logged; the session proceeds unrecorded).
 */
export const startInteractiveRun = async (input: {
  readonly config: RunRecorderConfig;
  readonly workspaceId: string;
  readonly ownerUserId: string;
}): Promise<string | undefined> => {
  try {
    const created = await postJson(new URL("/v1/runs", input.config.apiBaseUrl), "POST", {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      harnessId: SSH_HARNESS_ID,
      mode: "interactive",
    });
    if (!created.ok) {
      throw new Error(`createRun responded ${created.status}`);
    }
    const { runId } = createRunResponseSchema.parse(created.payload);

    const running = await postJson(
      new URL(`/v1/runs/${encodeURIComponent(runId)}`, input.config.apiBaseUrl),
      "PATCH",
      { status: "running" },
    );
    if (!running.ok) {
      throw new Error(`markRunning responded ${running.status}`);
    }
    return runId;
  } catch (error) {
    console.error("[ssh-gateway] interactive-run recording unavailable; session unrecorded", {
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};

/**
 * Finalize the interactive run on disconnect: capture the working-tree diff over the still-open
 * control connection (best-effort), then mark the run completed. `captureOutput` runs a shell
 * command in the workspace repo and returns its output (the gateway supplies `execCapture`).
 */
export const finalizeInteractiveRun = async (input: {
  readonly config: RunRecorderConfig;
  readonly runId: string;
  readonly captureOutput: ((command: string, cwd: string) => Promise<string>) | undefined;
}): Promise<void> => {
  let diff = "";
  let changedFiles: FileChange[] = [];
  if (input.captureOutput !== undefined) {
    try {
      diff = await input.captureOutput(
        "git add -A >/dev/null 2>&1; git --no-pager diff --cached 2>/dev/null",
        REPO_WORKDIR,
      );
      const names = await input.captureOutput(
        "git --no-pager diff --cached --name-status 2>/dev/null",
        REPO_WORKDIR,
      );
      changedFiles = parseNameStatus(names);
    } catch {
      // Diff capture is best-effort (the daemon may already be gone); the run still completes.
      diff = "";
      changedFiles = [];
    }
  }

  try {
    const completed = await postJson(
      new URL(`/v1/runs/${encodeURIComponent(input.runId)}`, input.config.apiBaseUrl),
      "PATCH",
      {
        status: "completed",
        exitCode: 0,
        ...(diff.length === 0 ? {} : { diff }),
        ...(changedFiles.length === 0 ? {} : { changedFiles }),
      },
    );
    if (!completed.ok) {
      throw new Error(`markCompleted responded ${completed.status}`);
    }
  } catch (error) {
    console.error("[ssh-gateway] failed to finalize interactive run", {
      runId: input.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
