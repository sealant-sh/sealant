/**
 * What an image build is doing, read from the builder's own output as it writes it.
 *
 * `docker build --progress=plain` writes one header line per build step (`#5 [2/12] RUN apt-get
 * …`, `#7 [stage-1 3/5] COPY …`), then the step's output; the classic builder writes
 * `Step 2/12 : RUN …`. The tracker keeps the furthest step it has seen and when the build last
 * wrote anything, which is what a caller needs to tell a slow build that is moving from one that
 * stalled.
 */

/** An image build's progress, as the builder reports it. */
export interface ImageBuildProgress {
  /** The furthest step the build has reached (1-based). */
  readonly step?: number;
  /** How many steps the build has. */
  readonly steps?: number;
  /** That step's instruction, shortened. */
  readonly stepName?: string;
  /** ISO-8601: when the build last wrote output. */
  readonly progressAt: string;
  /** How long the builder lets the build go without output before it fails it as stalled. */
  readonly stallTimeoutMs?: number;
}

const BUILDKIT_STEP = /^#\d+ \[(?:[^\]\s]+ )?(\d+)\/(\d+)\] (.+)$/;
const CLASSIC_STEP = /^Step (\d+)\/(\d+) : (.+)$/;
const STEP_NAME_LIMIT = 120;

const shorten = (instruction: string): string => {
  const collapsed = instruction.replace(/\s+/g, " ").trim();
  return collapsed.length <= STEP_NAME_LIMIT
    ? collapsed
    : `${collapsed.slice(0, STEP_NAME_LIMIT - 1).trimEnd()}…`;
};

export interface ImageBuildProgressTracker {
  /** Feed the builder's output as it arrives (any chunking). */
  readonly write: (text: string) => void;
  /** The progress so far; undefined until the build wrote anything. */
  readonly current: () => ImageBuildProgress | undefined;
}

export const createImageBuildProgressTracker = (options: {
  readonly onProgress?: (progress: ImageBuildProgress) => void;
  readonly stallTimeoutMs?: number;
  readonly now?: () => Date;
}): ImageBuildProgressTracker => {
  const now = options.now ?? (() => new Date());
  let partial = "";
  let step: { readonly step: number; readonly steps: number; readonly name: string } | undefined;
  let progress: ImageBuildProgress | undefined;

  const readLine = (line: string) => {
    const match = BUILDKIT_STEP.exec(line) ?? CLASSIC_STEP.exec(line);
    if (match === null) return;
    const current = Number(match[1]);
    const steps = Number(match[2]);
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(steps) || steps < 1) return;
    // Steps of one stage can run at once and their headers interleave: the furthest one seen is
    // where the build has got to.
    if (step === undefined || current >= step.step || steps !== step.steps) {
      step = { step: current, steps, name: shorten(match[3] ?? "") };
    }
  };

  return {
    write: (text) => {
      const lines = `${partial}${text}`.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) readLine(line);
      progress = {
        ...(step === undefined ? {} : { step: step.step, steps: step.steps }),
        ...(step === undefined || step.name.length === 0 ? {} : { stepName: step.name }),
        progressAt: now().toISOString(),
        ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
      };
      options.onProgress?.(progress);
    },
    current: () => progress,
  };
};

/** `step 2/12 (RUN apt-get update …)`, or what is known of it. */
export const describeImageBuildStep = (progress: ImageBuildProgress | undefined): string => {
  if (progress?.step === undefined || progress.steps === undefined) return "before its first step";
  return `at step ${String(progress.step)}/${String(progress.steps)}${
    progress.stepName === undefined ? "" : ` (${progress.stepName})`
  }`;
};
