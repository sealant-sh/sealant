/**
 * The boat-resource-links message codec: a link change round-trips, and a malformed message is
 * rejected before it reaches the worker (it dead-letters; the worker's sweep applies the link).
 */
import { describe, expect, it } from "vitest";

import {
  boatResourceLinkChangedMessageKind,
  boatResourceLinkQueue,
  parseBoatResourceLinkChangedMessage,
} from "./boat-resource-link-queue.js";

const base = { kind: boatResourceLinkChangedMessageKind, workspaceId: "ws_1", runId: "run_1" };

describe("parseBoatResourceLinkChangedMessage", () => {
  it("round-trips a link change and drops what it does not name", () => {
    expect(parseBoatResourceLinkChangedMessage({ ...base, extra: "ignored" })).toEqual(base);
  });

  it("rejects an unexpected kind, and a message that is not an object", () => {
    expect(() =>
      parseBoatResourceLinkChangedMessage({ ...base, kind: "workspace.stop.requested" }),
    ).toThrow(/unexpected kind/);
    expect(() => parseBoatResourceLinkChangedMessage("run_1")).toThrow(/not an object/);
    expect(() => parseBoatResourceLinkChangedMessage(null)).toThrow(/not an object/);
  });

  it("rejects a missing workspaceId or runId", () => {
    expect(() => parseBoatResourceLinkChangedMessage({ ...base, workspaceId: "" })).toThrow(
      /missing workspaceId/,
    );
    expect(() => parseBoatResourceLinkChangedMessage({ ...base, runId: 7 })).toThrow(
      /missing runId/,
    );
  });

  it("keeps one waiting message per run", () => {
    expect(boatResourceLinkQueue.collapseWaiting).toBe(true);
  });
});
