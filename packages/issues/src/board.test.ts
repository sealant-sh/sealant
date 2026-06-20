import { describe, expect, it } from "vitest";

import { createIssueWorkflowBoardOrder, moveIssueWorkflowBoardItem } from "./board.js";
import type { IssueWorkflowRecord } from "./types.js";

describe("issue workflow board helpers", () => {
  it("creates board order from workflow stages", () => {
    const order = createIssueWorkflowBoardOrder([
      createIssue("issue-1", "ready"),
      createIssue("issue-2", "triage"),
      createIssue("issue-3", "ready"),
    ]);

    expect(order).toEqual({
      active: [],
      done: [],
      ready: ["issue-1", "issue-3"],
      review: [],
      triage: ["issue-2"],
    });
  });

  it("moves an issue between workflow stages", () => {
    const order = createIssueWorkflowBoardOrder([
      createIssue("issue-1", "ready"),
      createIssue("issue-2", "active"),
    ]);

    expect(
      moveIssueWorkflowBoardItem(order, {
        issueId: "issue-1",
        sourceIndex: 0,
        sourceStage: "ready",
        targetIndex: 1,
        targetStage: "active",
      }),
    ).toEqual({
      active: ["issue-2", "issue-1"],
      done: [],
      ready: [],
      review: [],
      triage: [],
    });
  });
});

function createIssue(id: string, stage: IssueWorkflowRecord["stage"]): IssueWorkflowRecord {
  return {
    assigneeName: null,
    authorName: null,
    closedAt: null,
    commentCount: 0,
    createdAt: null,
    description: null,
    externalId: id,
    id,
    key: id,
    labels: [],
    number: null,
    priority: "none",
    provider: "github",
    repository: {
      id: null,
      name: "sealant/repo",
      owner: "sealant",
      url: null,
    },
    source: {
      externalId: id,
      importedAt: "2026-06-20T09:30:00.000Z",
      key: id,
      provider: "github",
      url: null,
    },
    stage,
    state: "open",
    teamName: null,
    title: id,
    updatedAt: null,
    url: null,
  };
}
