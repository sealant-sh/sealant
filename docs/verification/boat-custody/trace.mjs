// Shortens a TLC counterexample to one line per step: the action, then only the variables it
// changed. Reads TLC's output on standard input, or tlx's, whose trace has the same form.
//   tlc ... | node docs/verification/boat-custody/trace.mjs
import { createInterface } from "node:readline";

const lines = [];
for await (const line of createInterface({ input: process.stdin })) lines.push(line);

const steps = [];
let current;
let name;
for (const line of lines) {
  const header = /^State (\d+): (?:<(\w+)[^>]*>|(Initial predicate))/.exec(line);
  if (header) {
    const action = header[2] === undefined || header[2] === "Initial" ? "Init" : header[2];
    current = { n: Number(header[1]), action, vars: new Map() };
    steps.push(current);
    name = undefined;
    continue;
  }
  if (current === undefined) continue;
  if (
    line.trim() === "" ||
    /^\d+ states generated|^The depth|^Finished|^Error|^The behavior/.test(line)
  ) {
    current = undefined;
    continue;
  }
  const assignment = /^\/\\ (\w+) = (.*)$/.exec(line);
  if (assignment) {
    name = assignment[1];
    current.vars.set(name, assignment[2].trim());
  } else if (name !== undefined) {
    current.vars.set(name, `${current.vars.get(name)} ${line.trim()}`);
  }
}

if (steps.length === 0) {
  console.log("No counterexample in the input.");
  process.exit(0);
}

/** For a record such as [ a |-> "x", b |-> "y" ], only the fields that changed. */
const fields = (value) => {
  const match = /^\[(.*)\]$/.exec(value.replace(/\s+/g, " ").trim());
  if (!match) return undefined;
  const out = new Map();
  for (const part of match[1].split(/,(?=\s*\w+ \|->)/)) {
    const [key, ...rest] = part.split("|->");
    if (rest.length > 0) out.set(key.trim(), rest.join("|->").trim());
  }
  return out;
};

let previous = new Map();
for (const step of steps) {
  const changes = [];
  for (const [key, value] of step.vars) {
    const before = previous.get(key);
    if (before === value) continue;
    const now = fields(value);
    const then = before === undefined ? undefined : fields(before);
    if (now !== undefined && then !== undefined) {
      const changed = [...now].filter(([field, v]) => then.get(field) !== v);
      changes.push(`${key}[${changed.map(([field, v]) => `${field}=${v}`).join(", ")}]`);
    } else if (step.action !== "Init" || !/^(\[|<<)/.test(value)) {
      changes.push(`${key}=${value.replace(/\s+/g, " ")}`);
    }
  }
  console.log(`${String(step.n).padStart(2)}. ${step.action}: ${changes.join("  ")}`);
  previous = step.vars;
}
