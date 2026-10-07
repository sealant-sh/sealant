/**
 * The workspace RUN-EXEC queue — mirrors the workspace-build queue, but for executing a harness run
 * server-side. The API enqueues a message when a run is created with a `command`; the worker consumes
 * it, docker-execs the harness in the workspace, ingests telemetry, and marks the run terminal. This is
 * what lets the SDK be a thin HTTP client (it no longer docker-execs or writes telemetry itself).
 */
import {
  createJobQueueService,
  defineJobQueue,
  getJobQueueSingleton,
  jobQueueSchemaName,
  type JobQueueConsumerMessage,
} from "@sealant/jobs";

export const runExecQueueName = "workspace-run-exec";
export const runExecDeadLetterQueueName = "workspace-run-exec.dlq";

export const runExecRequestedMessageKind = "workspace.run-exec.requested";

/**
 * One invocation the worker execs in the workspace. Its arguments live in the job row only until
 * the worker takes it (`deleteOnPickup`), and the run record keeps their count and lengths, never
 * the arguments themselves (`withholdProcessArgs` in @sealant/telemetry).
 */
export interface RunExecCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

/**
 * A person's dotfiles applied as their user (`dotfiles.apply`). The archives are already staged in
 * the executor by the API (`archiveDir`, root's only): no file's bytes ride the job, and a
 * repository is cloned with no credential.
 */
export interface RunDotfilesApply {
  /** The Linux user (a login name or a decimal uid); never root. */
  readonly user: string;
  /** The user's passwd home, as the API checked it. */
  readonly home: string;
  readonly archiveDir?: string;
  readonly repository?: {
    readonly url: string;
    readonly reference?: string;
    readonly manager?: "auto" | "chezmoi" | "stow" | "copy";
    readonly bootstrap: boolean;
    readonly bootstrapCommand?: string;
  };
}

/**
 * Exactly one of the three framings is set:
 *
 * - `command` — HARNESS framing: one invocation; a nonzero exit marks the run failed.
 * - `commands` — EXEC (check-run) framing: an ordered list; every command executes regardless of
 *   exit codes (exit codes are check DATA), and the run completes iff all of them executed and were
 *   recorded. See `execWorkspaceRequestSchema` in @sealant/api-contracts for the full semantics.
 * - `dotfiles` — DOTFILES framing: `dotfiles.apply` as the user, then the bootstrap's process
 *   recorded to its exit; the run completes iff the files were applied and the bootstrap (if any)
 *   ended, with its exit code. See `applyWorkspaceDotfilesRequestSchema`.
 */
export interface RunExecRequestedMessage {
  readonly kind: typeof runExecRequestedMessageKind;
  readonly runId: string;
  readonly command?: RunExecCommand;
  readonly commands?: readonly RunExecCommand[];
  readonly dotfiles?: RunDotfilesApply;
}

/**
 * A harness run is one long-lived exec (an agent session can run for hours), so the active window
 * is a day; the run row itself is what a lost delivery is reconciled against.
 */
export const runExecQueue = defineJobQueue(runExecQueueName, {
  activeTimeoutSeconds: 24 * 60 * 60,
});

const parseCommand = (input: unknown, label: string): RunExecCommand => {
  const command = input as Record<string, unknown> | undefined;
  if (
    command === undefined ||
    command === null ||
    typeof command !== "object" ||
    typeof command.executable !== "string" ||
    command.executable.length === 0 ||
    !Array.isArray(command.args)
  ) {
    throw new Error(`Invalid run-exec message: missing/invalid ${label}.`);
  }
  return {
    executable: command.executable,
    args: command.args.map((arg) => String(arg)),
    ...(typeof command.cwd === "string" ? { cwd: command.cwd } : {}),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid run-exec message: ${label} must be a non-empty string.`);
  }
  return value;
};

const MANAGERS = ["auto", "chezmoi", "stow", "copy"] as const;

const parseDotfiles = (input: unknown): RunDotfilesApply => {
  if (!isRecord(input)) {
    throw new Error("Invalid run-exec message: dotfiles must be an object.");
  }
  const user = optionalString(input["user"], "dotfiles.user");
  const home = optionalString(input["home"], "dotfiles.home");
  if (user === undefined || home === undefined) {
    throw new Error("Invalid run-exec message: dotfiles names a user and a home.");
  }
  const archiveDir = optionalString(input["archiveDir"], "dotfiles.archiveDir");
  const repository = input["repository"];
  let parsedRepository: RunDotfilesApply["repository"];
  if (repository !== undefined) {
    if (!isRecord(repository)) {
      throw new Error("Invalid run-exec message: dotfiles.repository must be an object.");
    }
    const url = optionalString(repository["url"], "dotfiles.repository.url");
    if (url === undefined) {
      throw new Error("Invalid run-exec message: dotfiles.repository names a url.");
    }
    const manager = repository["manager"];
    const known = MANAGERS.find((candidate) => candidate === manager);
    if (manager !== undefined && known === undefined) {
      throw new Error("Invalid run-exec message: dotfiles.repository.manager is unknown.");
    }
    const reference = optionalString(repository["reference"], "dotfiles.repository.reference");
    const bootstrapCommand = optionalString(
      repository["bootstrapCommand"],
      "dotfiles.repository.bootstrapCommand",
    );
    parsedRepository = {
      url,
      ...(reference === undefined ? {} : { reference }),
      ...(known === undefined ? {} : { manager: known }),
      bootstrap: repository["bootstrap"] !== false,
      ...(bootstrapCommand === undefined ? {} : { bootstrapCommand }),
    };
  }
  if (archiveDir === undefined && parsedRepository === undefined) {
    throw new Error(
      "Invalid run-exec message: dotfiles names a repository or an archive directory.",
    );
  }
  return {
    user,
    home,
    ...(archiveDir === undefined ? {} : { archiveDir }),
    ...(parsedRepository === undefined ? {} : { repository: parsedRepository }),
  };
};

export const parseRunExecRequestedMessage = (input: unknown): RunExecRequestedMessage => {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid run-exec message: not an object.");
  }
  const obj = input as Record<string, unknown>;
  if (obj.kind !== runExecRequestedMessageKind) {
    throw new Error(`Invalid run-exec message: unexpected kind ${String(obj.kind)}.`);
  }
  if (typeof obj.runId !== "string" || obj.runId.length === 0) {
    throw new Error("Invalid run-exec message: missing runId.");
  }
  if (obj.dotfiles !== undefined) {
    return {
      kind: runExecRequestedMessageKind,
      runId: obj.runId,
      dotfiles: parseDotfiles(obj.dotfiles),
    };
  }
  if (obj.commands !== undefined) {
    if (!Array.isArray(obj.commands) || obj.commands.length === 0) {
      throw new Error("Invalid run-exec message: commands must be a non-empty array.");
    }
    return {
      kind: runExecRequestedMessageKind,
      runId: obj.runId,
      commands: obj.commands.map((entry, index) => parseCommand(entry, `commands[${index}]`)),
    };
  }
  return {
    kind: runExecRequestedMessageKind,
    runId: obj.runId,
    command: parseCommand(obj.command, "command"),
  };
};

/** Publishes a run-exec request (called by the API: createRun with a command, or execWorkspace). */
export const publishRunExecRequested = async (
  databaseUrl: string,
  input: {
    readonly runId: string;
    readonly command?: RunExecCommand;
    readonly commands?: readonly RunExecCommand[];
    readonly dotfiles?: RunDotfilesApply;
  },
): Promise<void> => {
  const framings = [input.command, input.commands, input.dotfiles].filter(
    (framing) => framing !== undefined,
  );
  if (framings.length !== 1) {
    throw new Error(
      "A run-exec request carries exactly one of `command`, `commands` or `dotfiles`.",
    );
  }
  const message: RunExecRequestedMessage = {
    kind: runExecRequestedMessageKind,
    runId: input.runId,
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.commands === undefined ? {} : { commands: input.commands }),
    ...(input.dotfiles === undefined ? {} : { dotfiles: input.dotfiles }),
  };
  const jobs = createJobQueueService(databaseUrl);
  await jobs.publishJson({ queue: runExecQueue, message });
};

export type RunExecConsumerMessage = JobQueueConsumerMessage<RunExecRequestedMessage>;

export interface ConsumeRunExecJobsOptions {
  readonly databaseUrl: string;
  readonly concurrency?: number;
  /** Throwing fails the delivery (dead-lettered, never retried). */
  readonly onMessage: (message: RunExecConsumerMessage) => Promise<void>;
}

export const consumeRunExecJobs = async (options: ConsumeRunExecJobsOptions) => {
  const jobs = createJobQueueService(options.databaseUrl);
  return jobs.consumeJson({
    queue: runExecQueue,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    parseMessage: parseRunExecRequestedMessage,
    // A command's arguments can carry secrets (a token, a file's bytes), so the row holding them
    // goes the moment the worker takes it. Nothing reads a run-exec job back, and nothing ever
    // consumed its dead-letter copies; a run whose worker died stays `queued` or `running` either
    // way (no reaper settles it today). `sweepRunExecJobRows` removes what a failed delete or an
    // older worker left.
    deleteOnPickup: true,
    onMessage: options.onMessage,
  });
};

/**
 * Deletes run-exec job rows that should not exist: a worker deletes each job when it takes it, so
 * a finished or dead-lettered copy, or a job `active` for over ten minutes (taken by a worker from
 * before that rule, or whose delete failed), is a leftover holding a command's arguments. Jobs no
 * worker has taken yet stay. The same rule as `sealant_purge_stored_arguments()` in the database.
 */
export const sweepRunExecJobRows = async (databaseUrl: string): Promise<number> => {
  const { boss } = await getJobQueueSingleton(databaseUrl);
  const result = await boss.getDb().executeSql(
    `WITH deleted AS (
       DELETE FROM ${jobQueueSchemaName}.job
       WHERE name = $2
         OR (name = $1 AND (
           state IN ('completed', 'failed', 'cancelled')
           OR (state = 'active' AND started_on < now() - interval '10 minutes')))
       RETURNING 1
     )
     SELECT count(*)::int AS deleted FROM deleted`,
    [runExecQueueName, runExecDeadLetterQueueName],
  );
  const row: unknown = result.rows[0];
  return typeof row === "object" &&
    row !== null &&
    "deleted" in row &&
    typeof row.deleted === "number"
    ? row.deleted
    : 0;
};
