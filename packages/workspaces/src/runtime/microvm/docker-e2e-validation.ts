import { agentHealthResponseSchema } from "./agent-contract.js";

const ALLOWED_ERROR_CODES: ReadonlySet<string> = new Set([
  "adapter-unavailable",
  "microvm-guest-failed",
  "unsupported-access-mode",
  "unsupported-runtime",
  "unsupported-runtime-requirement",
]);

const DOCKER_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "spawn-failed",
  "readiness-timeout",
  "exited",
  "probe-failed",
]);

const SAFE_GUEST_SIGNALS: ReadonlySet<string> = new Set([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGIO",
  "SIGKILL",
  "SIGPIPE",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
]);

export interface SafeErrorEvidence {
  readonly classification: "typed-error" | "unexpected-error";
  readonly code?: string | undefined;
  readonly phase?: "protocol" | "sealantd" | "docker" | undefined;
  readonly reason?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
}

export interface SafeAgentHealthEvidence {
  readonly classification:
    | "agent-health-invalid"
    | "agent-health-v1"
    | "agent-health-docker-starting"
    | "agent-health-docker-ready"
    | "agent-health-docker-failed"
    | "agent-health-sealantd-exited";
  readonly phase?: "sealantd" | "docker" | undefined;
  readonly reason?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly booted?: boolean | undefined;
  readonly controlSocket?: boolean | undefined;
}

const safeExitCode = (value: unknown): number | null | undefined => {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 255
    ? value
    : undefined;
};

const safeSignal = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }
  return typeof value === "string" && SAFE_GUEST_SIGNALS.has(value) ? value : undefined;
};

/** Retain only allowlisted fields from an error; never retain its message, cause, stack, or target. */
export const safeErrorEvidence = (error: unknown): SafeErrorEvidence => {
  if (typeof error !== "object" || error === null) {
    return { classification: "unexpected-error" };
  }

  try {
    const codeCandidate = "code" in error ? error.code : undefined;
    const phaseCandidate = "phase" in error ? error.phase : undefined;
    const code =
      typeof codeCandidate === "string" && ALLOWED_ERROR_CODES.has(codeCandidate)
        ? codeCandidate
        : undefined;
    const phase =
      phaseCandidate === "protocol" || phaseCandidate === "sealantd" || phaseCandidate === "docker"
        ? phaseCandidate
        : undefined;
    if (code !== "microvm-guest-failed" || phase !== "docker") {
      return {
        classification: code === undefined ? "unexpected-error" : "typed-error",
        ...(code === undefined ? {} : { code }),
        ...(phase === undefined ? {} : { phase }),
      };
    }

    const reasonCandidate = "failureReason" in error ? error.failureReason : undefined;
    const exitCodeCandidate = "guestExitCode" in error ? error.guestExitCode : undefined;
    const signalCandidate = "guestSignal" in error ? error.guestSignal : undefined;
    const reason =
      typeof reasonCandidate === "string" && DOCKER_FAILURE_REASONS.has(reasonCandidate)
        ? reasonCandidate
        : undefined;
    const exitCode = safeExitCode(exitCodeCandidate);
    const signal = safeSignal(signalCandidate);
    return {
      classification: "typed-error",
      code,
      phase,
      ...(reason === undefined ? {} : { reason }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(signal === undefined ? {} : { signal }),
    };
  } catch {
    return { classification: "unexpected-error" };
  }
};

/** Strictly parse authenticated agent health into bounded evidence without retaining its raw body. */
export const safeAgentHealthEvidence = (payload: unknown): SafeAgentHealthEvidence => {
  const parsed = agentHealthResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return { classification: "agent-health-invalid" };
  }
  const health = parsed.data;
  const common = { booted: health.booted, controlSocket: health.controlSocket };
  if (health.daemonExit !== undefined) {
    const exitCode = safeExitCode(health.daemonExit.code);
    const signal = safeSignal(health.daemonExit.signal);
    return {
      classification: "agent-health-sealantd-exited",
      phase: "sealantd",
      ...common,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(signal === undefined ? {} : { signal }),
    };
  }
  if (!("version" in health)) {
    return { classification: "agent-health-v1", ...common };
  }
  const docker = health.services.docker;
  if (docker.status === "starting") {
    return { classification: "agent-health-docker-starting", phase: "docker", ...common };
  }
  if (docker.status === "ready") {
    return { classification: "agent-health-docker-ready", phase: "docker", ...common };
  }
  const exitCode = safeExitCode(docker.code);
  const signal = safeSignal(docker.signal);
  return {
    classification: "agent-health-docker-failed",
    phase: "docker",
    reason: docker.reason,
    ...common,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
  };
};

type NestedDnsProbeMode = "default" | "aws-resolver-diagnostic";

/** The explicit AWS resolver is diagnostic only: a failed default probe always remains a failure. */
export const runNestedDnsAcceptanceProbes = async (
  probe: (mode: NestedDnsProbeMode) => Promise<void>,
): Promise<{ readonly defaultSucceeded: boolean; readonly diagnosticSucceeded?: boolean }> => {
  try {
    await probe("default");
    return { defaultSucceeded: true };
  } catch {
    try {
      await probe("aws-resolver-diagnostic");
      return { defaultSucceeded: false, diagnosticSucceeded: true };
    } catch {
      return { defaultSucceeded: false, diagnosticSucceeded: false };
    }
  }
};

export const matchesExpectedMicrovmDockerCandidate = (input: {
  readonly configuredArn: string;
  readonly configuredVersion: string;
  readonly expectedArn: string;
  readonly expectedVersion: string;
}): boolean =>
  input.configuredArn === input.expectedArn && input.configuredVersion === input.expectedVersion;
