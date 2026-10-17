import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Evaluator, Lexer, Parser, data } from "@actions/expressions";
import { parse } from "yaml";

const value = (v) => {
  if (typeof v === "string") return new data.StringData(v);
  const dictionary = new data.Dictionary();
  for (const [key, entry] of Object.entries(v)) dictionary.add(key, value(entry));
  return dictionary;
};

/** The concurrency group GitHub computes for a run, by GitHub's own expression library. */
const groupOf = (workflow, github) =>
  workflow.concurrency.group.replace(/\$\{\{(.+?)\}\}/g, (_, expression) => {
    const tree = new Parser(new Lexer(expression).lex().tokens, ["github"], []).parse();
    return new Evaluator(tree, value({ github })).evaluate().coerceString();
  });

const sha = "a".repeat(40);
const push = { event_name: "push", ref: "refs/heads/main", sha, run_id: "101" };
const pr = { event_name: "pull_request", ref: "refs/pull/7/merge", sha, run_id: "102" };
const dispatch = (run_id, ref = "refs/heads/main") => ({
  event_name: "workflow_dispatch",
  ref,
  sha,
  run_id,
});

test("a Kubernetes e2e dispatch never shares a group with a push, a pull request or another dispatch", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/kubernetes-e2e.yml", import.meta.url), "utf8"),
  );
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.equal(groupOf(workflow, push), "k8s-e2e-refs/heads/main");
  assert.equal(groupOf(workflow, pr), "k8s-e2e-refs/pull/7/merge");
  const groups = [push, pr, dispatch("201"), dispatch("202", "refs/pull/7/merge")].map((github) =>
    groupOf(workflow, github),
  );
  assert.equal(new Set(groups).size, groups.length, groups.join(" | "));
});
