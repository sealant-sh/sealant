import { describe, expect, it } from "vitest";

import { normalizeGitHubIssue } from "./github.js";

const repository = {
  id: "repo-1",
  name: "sealant-core",
  owner: "sealant-ops",
  url: "https://github.com/sealant-ops/sealant-core",
};

describe("GitHub issue import normalization", () => {
  it("normalizes REST issue payloads into issue workflow records", () => {
    const issue = normalizeGitHubIssue({
      importedAt: "2026-06-20T09:30:00.000Z",
      issue: {
        assignees: [{ login: "yiannis" }],
        body: "Needs enough context for a workflow.",
        closed_at: null,
        comments: 4,
        created_at: "2026-06-19T09:00:00Z",
        html_url: "https://github.com/sealant-ops/sealant-core/issues/12",
        id: 12_345,
        labels: [{ name: "ready" }, { name: "p1" }],
        number: 12,
        state: "open",
        title: "Import provider issue",
        updated_at: "2026-06-20T08:00:00Z",
        user: { login: "ops" },
      },
      repository,
    });

    expect(issue).toMatchObject({
      assigneeName: "yiannis",
      key: "sealant-ops/sealant-core#12",
      priority: "high",
      provider: "github",
      stage: "ready",
      state: "open",
      title: "Import provider issue",
    });
  });

  it("skips pull requests returned by the GitHub issues endpoint", () => {
    expect(
      normalizeGitHubIssue({
        issue: {
          id: 12_346,
          number: 13,
          pull_request: {},
          state: "open",
          title: "A pull request",
        },
        repository,
      }),
    ).toBeNull();
  });
});
