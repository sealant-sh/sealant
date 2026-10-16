// The test-only delay overrides stay out of the workflows (sealant-sh/mend #1034, merged as #1036).
// RELEASE_TEST_RETRY_MS shortens the retried reads in release.yml's publishing steps, and
// REPUBLISH_TEST_WAIT the npm integrity read-back; only the tests may set them. The guard is a
// plain text scan of the workflow files with no shell parser: it refuses text, so it never has to
// work out what Bash would make of a script, and it cannot hang.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const RELEASE = "release.yml";
const OVERRIDES = ["RELEASE_TEST_RETRY_MS", "REPUBLISH_TEST_WAIT"];
const NAMED = new RegExp(OVERRIDES.join("|"), "i");

// Rule 1. Text no workflow in the release graph may contain anywhere, comments included: none needs it.
const REFUSED_IN_RELEASE = [
  [/github_en/i, "GITHUB_ENV (in any case, or with its V assembled after GITHUB_EN)"],
  [/runner_file_commands|set_env_/i, "the file GITHUB_ENV points at, by its path"],
  [/allow_unsecure_commands/i, "the switch that brings back the retired ::set-env command"],
];

// Rule 2. The only lines, trimmed and whole, that may name an override, all in release.yml: the
// reads and each publishing step's preamble as they stand. Any other line naming one fails, so
// `: "${NAME:=0}"`, `export NAME=0`, `NAME=0 cmd`, `read NAME`, `printf -v NAME`, `declare NAME`
// and a `NAME<<EOF` record all do.
const OVERRIDE_LINES = new Map([
  [
    "# RELEASE_TEST_RETRY_MS, never a workflow; the log says which delays this run used.",
    "the comment over the retry preamble",
  ],
  ["if [[ -z ${RELEASE_TEST_RETRY_MS:-} ]]; then", "the preamble's unset test, a read"],
  [
    "elif [[ $RELEASE_TEST_RETRY_MS =~ ^(0|[1-9][0-9]{0,5})$ ]]; then",
    "the preamble's validation, a read",
  ],
  [
    'echo "retry backoff: overridden to $RELEASE_TEST_RETRY_MS ms × attempt"',
    "the log line, reached only with a validated value",
  ],
  [
    'echo "::error::RELEASE_TEST_RETRY_MS is not a whole number of milliseconds."',
    "the refusal, which names the variable and not its value",
  ],
  [
    "await new Promise((resolve) => setTimeout(resolve, attempt * Number(process.env.RELEASE_TEST_RETRY_MS || 1500)));",
    "a retry wait, a read with the production default",
  ],
  ["# REPUBLISH_TEST_WAIT, never a workflow.", "the comment over the integrity wait preamble"],
  ["if [[ -z ${REPUBLISH_TEST_WAIT:-} ]]; then", "the preamble's unset test, a read"],
  [
    "elif [[ $REPUBLISH_TEST_WAIT =~ ^(0|[1-9][0-9]{0,3})$ ]]; then",
    "the preamble's validation, a read",
  ],
  [
    'echo "integrity read-back wait: overridden to $REPUBLISH_TEST_WAIT s × attempt"',
    "the log line, reached only with a validated value",
  ],
  [
    'echo "::error::REPUBLISH_TEST_WAIT is not a whole number of seconds."',
    "the refusal, which names the variable and not its value",
  ],
  ["sleep $((attempt * ${REPUBLISH_TEST_WAIT:-5}))", "the integrity wait, a read with the default"],
]);

// Rule 4. The tracked files that may name an override: the release workflow and its tests. A
// script a release job runs could otherwise write $GITHUB_ENV itself.
const NAMING_FILES = [
  ".github/workflows/release.yml",
  "tooling/scripts/release-npm.test.mjs",
  "tooling/scripts/release-overrides.test.mjs",
  "tooling/scripts/release-publication.test.mjs",
];

const workflowTexts = () => {
  const directory = path.join(root, ".github/workflows");
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, readFileSync(path.join(directory, name), "utf8")]),
  );
};

/** Every mapping key in a parsed YAML document, however deep: env, with, matrix and the rest. */
function* keysOf(node, seen = new Set()) {
  if (node === null || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  for (const [key, value] of Object.entries(node)) {
    if (!Array.isArray(node)) yield key;
    yield* keysOf(value, seen);
  }
}

/** Every string value in a parsed YAML document, decoded, with the path to it. */
function* stringsOf(node, at = "", seen = new Set()) {
  if (typeof node === "string") yield [at, node];
  if (node === null || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  for (const [key, value] of Object.entries(node))
    yield* stringsOf(value, at === "" ? key : `${at}.${key}`, seen);
}

/** The rules, by the name a problem carries; `skip` turns one off, to show it is load-bearing. */
const RULE = {
  text: "rule 1 (GITHUB_ENV in the release graph)",
  lines: "rule 2 (an override named outside the approved lines)",
  keys: "rule 3 (an override as a YAML key)",
  decoded: "decoded",
};

/**
 * The problems in <workflows> (file name → text), and the release graph it read: release.yml and
 * every workflow it calls through `uses: ./.github/workflows/…`, transitively.
 *
 * Rules 1 and 2 read each line of a workflow twice: as written, comments included, and in every
 * string value YAML decodes from it, which is what the runner hands Bash or sets in the environment
 * (`run: "… \"$GITHUB_\x45NV\""` is written without GITHUB_ENV and decodes to it). A problem found
 * only in a decoded value says so.
 * 1. No file in the release graph contains any text of REFUSED_IN_RELEASE.
 * 2. A line naming an override is one of OVERRIDE_LINES in release.yml (and does not continue the
 *    line before it); in any other workflow, no line names one.
 * 3. No workflow has an override as a key: env or with at workflow, job or step level, a matrix
 *    entry, or a key YAML unescapes into one (`"RELEASE_TEST_\x52ETRY_MS": 0`), which rule 2 does
 *    not see.
 *
 * Writes to $GITHUB_ENV outside the release graph are allowed: kubernetes-e2e.yml writes KUBECONFIG
 * there. A job's $GITHUB_ENV reaches only that job's later steps, never another job, so it cannot
 * reach a release job, nor can a workflow's env reach a workflow it does not call.
 *
 * What a text scan of the workflows cannot see:
 * - a name a release step assembles from pieces at run time and exports itself, after its preamble
 *   (dynamic assembly);
 * - an action a release job uses, or a repository script it runs, writing $GITHUB_ENV or setting
 *   either variable when it runs (rule 4 keeps the names out of every other tracked file, which
 *   covers only scripts that spell them);
 * - the runner or its host supplying either variable;
 * - a workflow the graph does not follow: a remote reusable workflow (`owner/repo/…@ref`) or a local
 *   composite action (`./.github/actions/…`); none is in the release graph today.
 * The backstop is at run time: each publishing step logs, before anything else, the delays it read
 * ("retry backoff: production (1500 ms × attempt)" or "overridden to …"), so every release run's
 * log shows what its environment held when the step started.
 */
function overrideProblems(workflows, { skip = new Set() } = {}) {
  const problems = [];
  const parsed = Object.fromEntries(
    Object.entries(workflows).map(([file, text]) => [file, parse(text) ?? {}]),
  );
  const graph = new Set();
  for (const pending = [RELEASE]; pending.length > 0; ) {
    const file = pending.pop();
    if (graph.has(file)) continue;
    graph.add(file);
    if (!parsed[file]) problems.push(`the release graph calls ${file}, which is not here`);
    for (const job of Object.values(parsed[file]?.jobs ?? {})) {
      const called = /^\.\/\.github\/workflows\/([^/]+)$/.exec(job?.uses ?? "");
      if (called) pending.push(called[1]);
    }
  }
  for (const [file, text] of Object.entries(workflows)) {
    const sources = [[file, text, ""]];
    if (!skip.has("decoded"))
      for (const [at, value] of stringsOf(parsed[file]))
        sources.push([`${file} ${at}`, value, ` [${RULE.decoded}]`]);
    for (const [source, body, decoded] of sources) {
      const lines = body.split("\n");
      for (const [index, line] of lines.entries()) {
        const where = `${source}:${index + 1}`;
        if (graph.has(file) && !skip.has("text"))
          for (const [pattern, what] of REFUSED_IN_RELEASE)
            if (pattern.test(line))
              problems.push(`${RULE.text}${decoded}: ${where} names ${what}: ${line.trim()}`);
        if (skip.has("lines") || !NAMED.test(line)) continue;
        const allowed =
          file === RELEASE &&
          OVERRIDE_LINES.has(line.trim()) &&
          !(lines[index - 1] ?? "").trimEnd().endsWith("\\");
        if (!allowed) problems.push(`${RULE.lines}${decoded}: ${where}: ${line.trim()}`);
      }
    }
    if (!skip.has("keys"))
      for (const key of keysOf(parsed[file]))
        if (OVERRIDES.some((name) => name.toLowerCase() === key.toLowerCase()))
          problems.push(`${RULE.keys}: ${file} sets ${key} as a key (env, with or matrix)`);
  }
  return { graph, problems };
}

/** Rule 4: the tracked files naming an override, past the ones that may. */
const strayNamers = (files) => files.filter((file) => !NAMING_FILES.includes(file));

test("no workflow sets a test delay, and only the release workflow and its tests name one", (t) => {
  const workflows = workflowTexts();
  const { graph, problems } = overrideProblems(workflows);
  t.diagnostic(`release graph: ${[...graph].toSorted().join(", ")}`);
  assert.deepEqual(problems, []);
  assert.deepEqual([...graph], [RELEASE]);
  // Every approved line is still there: an approval outlives nothing it was given for.
  const lines = new Set(workflows[RELEASE].split("\n").map((line) => line.trim()));
  for (const line of OVERRIDE_LINES.keys())
    assert.ok(lines.has(line), `approved but gone: ${line}`);
  const named = execFileSync("git", ["grep", "-l", "-i", "-E", OVERRIDES.join("|")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.deepEqual(strayNamers(named.trim().split("\n")), []);
});

/** <workflows> with <step> (YAML lines under `- name: Injected`) first in <job> of <file>. */
const withStep = (workflows, file, job, step) => {
  const text = workflows[file];
  const header = text.indexOf(`\n  ${job}:\n`);
  assert.ok(header >= 0, `${file} has a ${job} job`);
  const at = text.indexOf("\n    steps:\n", header) + "\n    steps:\n".length;
  const lines = ["- name: Injected", ...step].map((line) => `      ${line}`);
  return { ...workflows, [file]: `${text.slice(0, at)}${lines.join("\n")}\n${text.slice(at)}` };
};
const runStep = (script) => ["  run: |", ...script.split("\n").map((line) => `    ${line}`)];
/** <workflows> with <lines> inserted after <after>, the first time it follows <job> in <file>. */
const withLines = (workflows, file, job, after, lines) => {
  const text = workflows[file];
  const header = text.indexOf(`\n  ${job}:\n`);
  assert.ok(header >= 0, `${file} has a ${job} job`);
  const at = text.indexOf(after, header) + after.length;
  assert.ok(at >= after.length, `${file} ${job} has ${after}`);
  return { ...workflows, [file]: `${text.slice(0, at)}${lines.join("\n")}\n${text.slice(at)}` };
};

const TEXT = new RegExp(`^${RULE.text.replace(/[()]/g, "\\$&")}: `);
const DECODED_TEXT = new RegExp(`^${RULE.text.replace(/[()]/g, "\\$&")} \\[decoded\\]: `);
const LINE = new RegExp(`^${RULE.lines.replace(/[()]/g, "\\$&")}: `);
const DECODED_LINE = new RegExp(`^${RULE.lines.replace(/[()]/g, "\\$&")} \\[decoded\\]: `);
const KEY = new RegExp(`^${RULE.keys.replace(/[()]/g, "\\$&")}: `);

/** Each mutation, the workflows it makes, and the rules that must name it. */
const mutations = () => {
  const workflows = workflowTexts();
  return [
    // Astra's round-1 mutation of this stack, before the step that publishes.
    [
      "Astra's printf heredoc",
      withStep(
        workflows,
        RELEASE,
        "promote",
        runStep(
          `printf '%s\\n' 'RELEASE_TEST_RETRY_MS<<EOF' 0 EOF 'REPUBLISH_TEST_WAIT<<EOF' 0 EOF >>"$GITHUB_ENV"`,
        ),
      ),
      TEXT,
      LINE,
    ],
    // sealant-sh/mend #1034's multiline write.
    [
      "the issue's heredoc group",
      withStep(
        workflows,
        RELEASE,
        "promote",
        runStep('{ echo "RELEASE_TEST_RETRY_MS<<EOF"; echo 0; echo EOF; } >> "$GITHUB_ENV"'),
      ),
      TEXT,
      LINE,
    ],
    // The name never spelled whole: only GITHUB_ENV gives it away.
    [
      "printf %b",
      withStep(
        workflows,
        RELEASE,
        "finalize-images",
        runStep(`printf '%b=0\\n' 'RELEASE_TEST_\\x52ETRY_MS' >> "$GITHUB_ENV"`),
      ),
      TEXT,
    ],
    // Escapes YAML decodes: the source names neither GITHUB_ENV nor an override, the decoded value
    // does, and Bash runs the decoded value.
    [
      "GITHUB_ENV escaped in a double-quoted run",
      withStep(workflows, RELEASE, "promote", [
        String.raw`  run: "printf '%s%s=0\\n' RELEASE_TEST_ RETRY_MS >> \"$GITHUB_\x45NV\""`,
      ]),
      DECODED_TEXT,
    ],
    [
      "an assignment escaped in a double-quoted run",
      withStep(workflows, RELEASE, "promote", [
        String.raw`  run: "RELEASE_TEST_RETRY_\x4dS=0 node publish.mjs"`,
      ]),
      DECODED_LINE,
    ],
    // ${NAME:=0} assigns; under set -a it exports.
    [
      "set -a with ${NAME:=0}",
      withStep(
        workflows,
        RELEASE,
        "promote",
        runStep('set -a\n: "${RELEASE_TEST_RETRY_MS:=0}"\nset +a'),
      ),
      LINE,
    ],
    [
      "export",
      withStep(workflows, RELEASE, "promote", runStep("export REPUBLISH_TEST_WAIT=0")),
      LINE,
    ],
    [
      "a step env key",
      withStep(workflows, RELEASE, "promote", [
        "  env:",
        '    RELEASE_TEST_RETRY_MS: "0"',
        "  run: true",
      ]),
      LINE,
      KEY,
    ],
    // YAML unescapes the key; only the key check sees it.
    [
      "a step env key YAML unescapes",
      withStep(workflows, RELEASE, "promote", [
        "  env:",
        '    "RELEASE_TEST_\\x52ETRY_MS": "0"',
        "  run: true",
      ]),
      KEY,
    ],
    [
      "a matrix key",
      withLines(workflows, RELEASE, "build", "      matrix:\n", [
        "        env:",
        '          - { REPUBLISH_TEST_WAIT: "0" }',
      ]),
      LINE,
      KEY,
    ],
    // The names belong to release.yml alone: even an approved read fails anywhere else.
    [
      "an approved read in another workflow",
      withStep(
        workflows,
        "next.yml",
        "image",
        runStep("if [[ -z ${RELEASE_TEST_RETRY_MS:-} ]]; then echo production; fi"),
      ),
      LINE,
    ],
  ];
};

test("the guard refuses each way a mutation sets an override, and says which rule caught it", () => {
  for (const [form, mutated, ...expected] of mutations()) {
    const { problems } = overrideProblems(mutated);
    for (const pattern of expected)
      assert.ok(
        problems.some((problem) => pattern.test(problem)),
        `${form}: expected ${pattern}, got ${problems.join("; ") || "none"}`,
      );
  }
});

test("each rule is load-bearing: without it, some mutation passes unseen", () => {
  const unseen = (skip) =>
    mutations()
      .filter(
        ([, mutated]) => overrideProblems(mutated, { skip: new Set([skip]) }).problems.length === 0,
      )
      .map(([form]) => form);
  // Nothing passes with every rule on.
  assert.deepEqual(
    mutations()
      .filter(([, mutated]) => overrideProblems(mutated).problems.length === 0)
      .map(([form]) => form),
    [],
  );
  assert.deepEqual(unseen("text"), ["printf %b", "GITHUB_ENV escaped in a double-quoted run"]);
  assert.deepEqual(unseen("lines"), [
    "an assignment escaped in a double-quoted run",
    "set -a with ${NAME:=0}",
    "export",
    "an approved read in another workflow",
  ]);
  assert.deepEqual(unseen("keys"), ["a step env key YAML unescapes"]);
  assert.deepEqual(unseen("decoded"), [
    "GITHUB_ENV escaped in a double-quoted run",
    "an assignment escaped in a double-quoted run",
  ]);
  // Rule 4: a tracked script naming an override is refused; without the rule nothing would be.
  assert.deepEqual(strayNamers([...NAMING_FILES, "tooling/scripts/publish.mjs"]), [
    "tooling/scripts/publish.mjs",
  ]);
});

test("$GITHUB_ENV writes outside the release graph pass, and the same write inside it fails", () => {
  const workflows = workflowTexts();
  const { graph } = overrideProblems(workflows);
  // Today's writer: kubernetes-e2e.yml's KUBECONFIG, not in the graph.
  const writers = Object.keys(workflows).filter((file) => /GITHUB_ENV/.test(workflows[file]));
  assert.deepEqual(writers, ["kubernetes-e2e.yml"]);
  for (const file of writers) assert.ok(!graph.has(file), file);
  const write = 'echo "FOO=bar" >> "$GITHUB_ENV"';
  assert.deepEqual(
    overrideProblems(withStep(workflows, "ci.yml", "lint", runStep(write))).problems,
    [],
  );
  const released = overrideProblems(withStep(workflows, RELEASE, "build", runStep(write)));
  assert.ok(
    released.problems.some((problem) => TEXT.test(problem) && problem.includes("release.yml:")),
  );
  // A workflow release.yml calls joins the graph, and its writes fail too.
  const called = {
    ...workflows,
    "helper.yml": `on: workflow_call\njobs:\n  helper:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: ${write}\n`,
  };
  called[RELEASE] = called[RELEASE].replace(
    "\njobs:\n",
    "\njobs:\n  helper:\n    uses: ./.github/workflows/helper.yml\n",
  );
  const traversed = overrideProblems(called);
  assert.ok(traversed.graph.has("helper.yml"));
  assert.ok(
    traversed.problems.some((problem) => TEXT.test(problem) && problem.includes("helper.yml:")),
  );
});
