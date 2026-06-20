import { describe, expect, it } from "vitest";

import { normalizeLinearIssue } from "./linear.js";

describe("Linear issue import normalization", () => {
  it("normalizes GraphQL issue nodes into issue workflow records", () => {
    const issue = normalizeLinearIssue({
      importedAt: "2026-06-20T09:30:00.000Z",
      issue: {
        archivedAt: null,
        assignee: { displayName: "Ari", id: "user-1", name: "Ari Lane" },
        canceledAt: null,
        completedAt: null,
        createdAt: "2026-06-18T10:00:00Z",
        creator: { displayName: "Nia", id: "user-2", name: "Nia Chen" },
        description: "Should appear in the ready lane.",
        id: "linear-1",
        identifier: "SEL-42",
        labels: { nodes: [{ id: "label-1", name: "ready" }] },
        number: 42,
        priority: 2,
        project: { id: "project-1", name: "sealant/web" },
        state: { id: "state-1", name: "Ready for workflow", type: "unstarted" },
        team: { id: "team-1", name: "Product Systems" },
        title: "Import Linear issue",
        updatedAt: "2026-06-20T08:15:00Z",
        url: "https://linear.app/sealant/issue/SEL-42/import-linear-issue",
      },
    });

    expect(issue).toMatchObject({
      assigneeName: "Ari",
      key: "SEL-42",
      priority: "high",
      provider: "linear",
      repository: { name: "sealant/web" },
      stage: "ready",
      teamName: "Product Systems",
    });
  });
});
