/**
 * A ready session's daemon watched through `inspect`, clean Stops spread across the sweep period,
 * and a DELETE whose reply is lost (#598).
 */
import { describe } from "vitest";

import { agentBrieflyUnreachable, daemonKilled } from "./daemon-scenario.js";
import { deleteReplyLost, deleteReplyLostWhileDeleting } from "./deletion-scenario.js";
import { harnessFile } from "./harness-file.js";
import { cleanStopsInOnePass, noResourcesStopsInOnePass } from "./stop-scenario.js";

const { scenario } = harnessFile({ publishSnapshot: true });

describe("a ready session's daemon and its deletion", () => {
  scenario(
    "six clean Stops across the sweep period, each in one pass",
    undefined,
    cleanStopsInOnePass,
  );
  scenario(
    "no resources: six clean Stops across the sweep period, each in one pass",
    undefined,
    noResourcesStopsInOnePass,
  );
  scenario(
    "agent unreachable, then 503, for a few polls: the session goes on",
    undefined,
    agentBrieflyUnreachable,
  );
  scenario(
    "sealantd killed in a ready session: failed, FINAL, one DELETE, edit restored",
    undefined,
    daemonKilled,
    40 * 60_000,
  );
  scenario(
    "DELETE reply lost while the deletion runs: one operation, confirmed",
    undefined,
    deleteReplyLostWhileDeleting,
  );
  scenario(
    "DELETE reply lost, VM gone by the next pass: one operation",
    undefined,
    deleteReplyLost,
  );
});
