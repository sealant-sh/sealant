export const REPO_URL = "https://github.com/get-sealant/sealant";

export const heroHeadline = [
  "Secure AI coding runs.",
  "Reviewable from first command",
  "to final PR.",
];

export const heroSubcopy =
  "Sealant runs repositories, issues, and agent tasks inside isolated sandboxes, records what happened inside the runtime, and turns every run into a fast, trustworthy review.";

export const heroSplitIssue = {
  repo: "acme/billing",
  number: "#482",
  title: "Fix billing retry bug",
  assignedTo: "Codex",
};

export const heroSplitSandboxCommands = ["pnpm install", "pnpm test", "pnpm typecheck"];

export const heroSplitPrSignals: ReadonlyArray<{ readonly k: string; readonly v: string }> = [
  { k: "Commands run", v: "14" },
  { k: "Files changed", v: "3" },
  { k: "Tests passed", v: "11 / 12" },
  { k: "Network", v: "restricted" },
  { k: "Secrets", v: "scoped" },
  { k: "Validation", v: "complete" },
];

export const painPoints: ReadonlyArray<{ readonly title: string; readonly body: string }> = [
  {
    title: "Agents need secure, disposable environments",
    body: "Running an agent on a laptop gives it your files, your secrets, and your network. Runs need a controlled place they can be torn down after.",
  },
  {
    title: "Runs must be reproducible",
    body: "A diff without its environment is a guess. Reviewers need to know the exact repo ref, tooling, and policy a run used.",
  },
  {
    title: "PRs need evidence, not just summaries",
    body: "A reviewer gets a diff and a summary, but not the execution trail: what commands ran, what changed, what failed, what access the agent had.",
  },
  {
    title: "Work should start from anywhere",
    body: "Issues arrive in GitHub, Linear, Slack, or your phone. Waiting to be at a laptop to kick off a run slows the whole loop.",
  },
];

export const problemIntro =
  "AI coding agents are powerful, but their work is often invisible. A reviewer gets a diff and a summary, but not the actual execution trail: what environment it ran in, what commands executed, what changed, what failed, what passed, and what access the agent had.";

export const pipelineStages: ReadonlyArray<{
  readonly step: string;
  readonly label: string;
  readonly items: ReadonlyArray<string>;
}> = [
  { step: "01", label: "Trigger", items: ["issue", "repo", "PR", "SDK", "phone"] },
  { step: "02", label: "Policy", items: ["secrets", "network", "tools", "approvals"] },
  { step: "03", label: "Sandbox", items: ["isolated runtime"] },
  { step: "04", label: "Recorder", items: ["commands", "processes", "files", "output", "events"] },
  { step: "05", label: "Validation", items: ["tests", "lint", "typecheck", "custom checks"] },
  { step: "06", label: "Review", items: ["summary", "diff", "risk", "evidence"] },
];

export const pipelineFlow = "Trigger → Policy → Sandbox → Recorder → Validation → Reviewable PR";

export const coreProductCopy =
  "A Sealant run starts from a repo, issue, PR, SDK call, or mobile action. Sealant launches an isolated sandbox, runs the human or AI workflow, and records the execution from inside the runtime.";

export const securityCaps: ReadonlyArray<{ readonly label: string; readonly detail: string }> = [
  {
    label: "Disposable sandboxes",
    detail:
      "Each run gets a fresh runtime, torn down when the run ends. Nothing persists by default.",
  },
  {
    label: "Scoped repository access",
    detail:
      "A run sees only the repo and ref it was given. Access is resolved per run, not inherited.",
  },
  {
    label: "Scoped secrets and SSH keys",
    detail: "Secrets are injected per run and scoped to the policy. They do not live in the image.",
  },
  {
    label: "Network and runtime policy",
    detail:
      "Restrict outbound network, pick the runtime isolation level, and bound what the run can do.",
  },
  {
    label: "Per-run environment records",
    detail:
      "Every run records the environment it ran in: tooling, harness, policy, and runtime config.",
  },
  {
    label: "Stronger runtime isolation",
    detail:
      "Optional gVisor / runsc isolation for runs that need a harder boundary than the default.",
  },
  {
    label: "Approval gates for risky actions",
    detail: "Hold a run for a human decision before risky changes, secret access, or PR creation.",
  },
];

export const securityIntro =
  "Sealant gives AI coding work a controlled place to execute. Each run can be isolated, scoped, observed, and shut down without depending on a developer machine.";

export const fingerprint: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: "Repository", value: "acme/billing" },
  { label: "Ref", value: "main@8f3c…" },
  { label: "Sandbox image", value: "sha256:…" },
  { label: "Harness", value: "Codex / Claude Code / OpenCode" },
  { label: "Runtime", value: "Docker / Kubernetes" },
  { label: "Policy", value: "restricted network, scoped secrets" },
  { label: "Validation", value: "12 checks · 11 passed · 1 warning" },
];

export const reproducibilityCopyP1 =
  "Sealant captures the inputs that matter: repo ref, issue context, environment profile, packages, dotfiles, runtime, harness, commands, logs, artifacts, validation, and final diff.";

export const reproducibilityCopyP2 =
  "This lets teams rerun, resume, compare, debug, and explain software work.";

export const reviewRows: ReadonlyArray<{
  readonly label: string;
  readonly value: string;
  readonly kind: "text" | "tests" | "flags";
  readonly flags?: readonly string[];
  readonly tests?: { readonly passed: number; readonly failed: number; readonly skipped: number };
}> = [
  { label: "Objective", value: "Fix retry handling for failed invoices", kind: "text" },
  { label: "Commands", value: "pnpm test · pnpm typecheck · pnpm lint", kind: "text" },
  { label: "Files changed", value: "3 files, grouped by intent", kind: "text" },
  {
    label: "Tests",
    value: "11 passed · 1 failed · 0 skipped",
    kind: "tests",
    tests: { passed: 11, failed: 1, skipped: 0 },
  },
  {
    label: "Risk flags",
    value: "auth touched, migration added, dependency changed",
    kind: "flags",
    flags: ["auth touched", "migration added", "dependency changed"],
  },
  {
    label: "Agent notes",
    value: "Assumptions and uncertainties recorded by the agent",
    kind: "text",
  },
  { label: "Evidence", value: "Raw logs and runtime events available", kind: "text" },
];

export const reviewIntro =
  "Sealant compresses PR review by showing what happened during the run: the objective, plan, commands, test results, file changes, risky areas, unexplained edits, and validation status.";

export const phoneNotifications: ReadonlyArray<{
  readonly title: string;
  readonly detail: string;
}> = [
  { title: "Run issue in sandbox", detail: "acme/billing · #482" },
  { title: "Approve secret access", detail: "STRIPE_SECRET_KEY" },
  { title: "Validation finished", detail: "11 / 12 checks passed" },
  { title: "PR ready for review", detail: "fix: retry handling" },
];

export const runSources = ["Web app", "GitHub", "Slack", "Linear", "CLI", "SDK", "Phone"];

export const runAnywhereCopy =
  "Kick off a sandbox or issue workflow from the web app, GitHub, Slack, Linear, CLI, SDK, or your phone. The run happens in Sealant infrastructure, not on your laptop.";

export interface SdkModule {
  readonly name: string;
  readonly methods: readonly string[];
}

export const sdkModules: ReadonlyArray<SdkModule> = [
  { name: "Sandboxes", methods: ["create", "connect", "inspect", "stop", "retry"] },
  { name: "Issue Workflows", methods: ["run", "observe", "validate", "report"] },
  { name: "Runtime Events", methods: ["commands", "output", "lifecycle", "artifacts"] },
  { name: "Policies", methods: ["secrets", "network", "approvals", "permissions"] },
  { name: "Harnesses", methods: ["Codex", "Claude Code", "OpenCode", "custom"] },
  { name: "Integrations", methods: ["GitHub first", "more providers"] },
];

export const sdkCopy =
  "Sealant exposes sandboxes, issue workflows, runtime events, profiles, policies, registries, and harnesses as programmable modules.";

export const SDK_CODE_LINES: readonly string[] = [
  "const run = await sealant.issueWorkflows.run({",
  '  repo: "acme/billing",',
  "  issue: 482,",
  '  harness: "codex",',
  '  policy: "review-required",',
  "});",
  "",
  'await run.waitUntil("pr.ready");',
];

export const architecturePoints: readonly string[] = [
  "Control plane for lifecycle and policy",
  "Build workers for reproducible images",
  "Runtime adapters for Docker and Kubernetes",
  "SSH gateway for editor and terminal access",
  "Binary recorder inside the runtime",
  "Event stream and artifacts for review",
  "Contract-first API and SDK modules",
];

export const finalCtaHeadline = "Give AI coding work a place to run and a record to trust.";

export const sectionHeadlines = {
  problem: "AI can write code. Teams still need to trust the work.",
  coreProduct: "Every run gets a sandbox and a recorder.",
  security: "Agents run with boundaries.",
  reproducibility: "A run is a real artifact, not a chat transcript.",
  review: "Review the run before you review the diff.",
  anywhere: "Start work wherever the issue finds you.",
  sdk: "Build your own workflows on the run layer.",
  architecture: "Built for real execution, not demos.",
};
