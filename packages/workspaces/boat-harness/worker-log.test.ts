import { describe, expect, it } from "vitest";

import {
  completeFinals,
  entriesOf,
  isUnfinishedPass,
  isWarningOrAbove,
  splitEntries,
} from "./worker-log.js";

const RUN = "7f82d189-0399-43c3-8c31-cd79b69a1326";
const OTHER = "06c7c33b-4a49-4fb9-9443-4e0f5d0c7087";

// Shaped as the worker writes them: Effect log lines with indented continuations, and
// console.warn blocks with no time or level.
const log = [
  `[23:26:04.319] INFO (#12965): Capture drain (lifecycle stop) · run ${RUN}: saved · pending 0 · 0 bytes to ship · registered 2 · final flush complete`,
  `[23:26:04.326] ERROR (#12965): Capture drain · run ${RUN}: the runtime call removing its executor failed with an outcome nobody knows (the request may have reached the runtime)`,
  `  error: WorkspaceStopProcessingError: Boat runtime: close-unavailable`,
  `    at stop (file:///worker/dist/index.js:1:1)`,
  `Workspace stop deferred to the reaper: capture work not yet confirmed saved {`,
  `  workspaceId: 'ws_1',`,
  `  runId: '${OTHER}',`,
  `  outcome: 'busy'`,
  `}`,
  `Workspace stop deferred to the reaper: capture work not yet confirmed saved {`,
  `  workspaceId: 'ws_2',`,
  `  runId: '${RUN}',`,
  `  outcome: 'draining'`,
  `}`,
  `[23:26:31.455] INFO (#13031): Capture drain (Boat convergence) · run ${OTHER}: saved · pending 0 · final flush complete`,
  `Sealant worker starting {`,
  `  workerId: 'w'`,
  `}`,
].join("\n");

describe("worker log", () => {
  it("splits Effect lines and console blocks into entries, continuations kept with them", () => {
    const entries = splitEntries(log);
    expect(entries).toHaveLength(6);
    expect(entries[1]).toContain("close-unavailable");
    expect(entries[2]).toContain(OTHER);
  });

  it("keeps a run's entries and those naming no run", () => {
    const mine = entriesOf(splitEntries(log), RUN);
    expect(mine.map((entry) => entry.slice(0, 30))).toEqual([
      `[23:26:04.319] INFO (#12965): `,
      `[23:26:04.326] ERROR (#12965):`,
      "Workspace stop deferred to the",
      "Sealant worker starting {\n  wo",
    ]);
  });

  it("reads an unfinished pass, allowing only a deferral the nudge won (busy)", () => {
    const entries = splitEntries(log);
    expect(entries.map(isUnfinishedPass)).toEqual([false, true, false, true, false, false]);
  });

  it("reads warnings from levels and from the worker's console warnings", () => {
    expect(splitEntries(log).map(isWarningOrAbove)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("names who completed each FINAL of a run", () => {
    const entries = splitEntries(log);
    expect(completeFinals(entries, RUN)).toEqual(["lifecycle stop"]);
    expect(completeFinals(entries, OTHER)).toEqual(["Boat convergence"]);
  });
});
