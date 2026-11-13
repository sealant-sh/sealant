/**
 * Every scenario runs once in CI. The harness is split into `*.harness.ts` files that CI runs on
 * separate runners, one matrix group each (`.github/workflows/boat-harness.yml`). A scenario
 * written but registered in no harness file, registered in two, or in a file no group runs would
 * silently not run, or run twice.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { scenarios } from "./faults.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const workflow = join(here, "../../../.github/workflows/boat-harness.yml");

/** Each harness file's path as the workflow names it (relative to the package), and its source. */
const harnessFiles = async () => {
  const names = (await readdir(here)).filter((name) => name.endsWith(".harness.ts"));
  return Promise.all(
    names.map(async (name) => ({
      path: `boat-harness/${name}`,
      source: await readFile(join(here, name), "utf8"),
    })),
  );
};

/**
 * Every scenario body a harness file can register: each `*-scenario.ts` module's exports that take
 * the stack and the project, and each of `faults.ts`'s `scenarios`. A body a harness file defines
 * itself (the happy path) is registered where it is written.
 */
const scenarioBodies = async () => {
  const modules = (await readdir(here)).filter((name) => name.endsWith("-scenario.ts"));
  const exported: { readonly name: string; readonly reference: RegExp }[] = [];
  for (const module of modules) {
    const source = await readFile(join(here, module), "utf8");
    for (const match of source.matchAll(
      /^export const (\w+) = (?:async )?\(\s*stack: HarnessStack,\s*project: Project\b/gm,
    ))
      exported.push({ name: `${module}: ${match[1]}`, reference: new RegExp(`\\b${match[1]}\\b`) });
  }
  const faults = Object.keys(scenarios).map((key) => ({
    name: `faults.ts: ${key}`,
    reference: new RegExp(`\\bscenarios\\.${key}\\b`),
  }));
  return [...exported, ...faults];
};

const matrixSchema = z.object({
  jobs: z.object({
    harness: z.object({
      strategy: z.object({
        matrix: z.object({
          include: z.array(z.object({ group: z.string(), files: z.string() })).min(1),
        }),
      }),
    }),
  }),
});

describe("the harness split", () => {
  it("registers every scenario in exactly one harness file", async () => {
    const files = await harnessFiles();
    const bodies = await scenarioBodies();
    expect(bodies).not.toEqual([]);
    const misplaced = bodies.flatMap((body) => {
      const registeredIn = files.filter((file) => body.reference.test(file.source));
      return registeredIn.length === 1
        ? []
        : [`${body.name} in ${registeredIn.map((file) => file.path).join(", ") || "no file"}`];
    });
    expect(misplaced).toEqual([]);
  });

  it("runs every harness file in exactly one CI group", async () => {
    const files = (await harnessFiles()).map((file) => file.path);
    const groups = matrixSchema.parse(parse(await readFile(workflow, "utf8"))).jobs.harness.strategy
      .matrix.include;
    const listed = groups.flatMap((group) => group.files.split(/\s+/).filter(Boolean));
    expect(listed.filter((path) => !files.includes(path))).toEqual([]);
    const misplaced = files.filter((path) => listed.filter((entry) => entry === path).length !== 1);
    expect(misplaced).toEqual([]);
  });
});
