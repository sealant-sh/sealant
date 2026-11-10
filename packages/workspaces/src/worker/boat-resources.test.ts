import { describe, expect, it } from "vitest";

import { boatResourceObligations } from "./boat-resources.js";

describe("Boat resource obligations", () => {
  it("never reports a run that was launched without resources", () => {
    // Its allocation row stays for good and answers `no-resources` on every pass: reported, the
    // warning would list every such run every 30 s and bury a tunnel that really is held.
    expect(
      boatResourceObligations([
        { runId: "run_configured", outcome: "configured" },
        { runId: "run_closed", outcome: "closed" },
        { runId: "run_pending", outcome: "pending" },
        { runId: "run_without_resources", outcome: "no-resources" },
      ]),
    ).toEqual([]);
  });

  it("reports a run whose resources are held or unavailable", () => {
    expect(
      boatResourceObligations([
        { runId: "run_without_resources", outcome: "no-resources" },
        { runId: "run_held", outcome: "held" },
        { runId: "run_unavailable", outcome: "unavailable" },
      ]),
    ).toEqual([
      { runId: "run_held", outcome: "held" },
      { runId: "run_unavailable", outcome: "unavailable" },
    ]);
  });
});
