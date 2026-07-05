---
title: Issue workflows
description:
  Preview — the issue board and Linear import as they exist today, and the parts that are still
  seeded, non-persistent, or unbuilt.
---

> **Preview.** Issue workflows are an early, mostly-static surface. The Linear connect and import
> path is real, but the board itself is a preview: seeded rows are static, moving cards does not
> persist, and there is no issue-workflow API yet. Treat this page as a status report, not a stable
> feature.

Issue workflows are meant to be one of Sealant's two primary product domains — the path from an
incoming issue to a sandbox and a reviewed change. Today the web app ships the board shell and a
working Linear import, with the rest still ahead.

## The issue board

The board lives at `/issues`, with `/issues/assigned` and `/issues/ready` as filtered views of the
same data. Each column is a workflow stage, and each card shows:

- a **provider badge** (GitHub or Linear),
- **priority**, **labels**, and **assignee**,
- the **repository** and last **update time**,
- a link out to the **external issue**.

You can drag cards between columns. That reordering is **local UI state only** — it is not
persisted, and a refresh resets it.

## Connect Linear (real)

The one fully wired integration is Linear OAuth. It runs through:

- `/api/linear/connect` — start the OAuth flow.
- `/api/linear/callback` — complete it.
- `/api/linear/status` — check the current connection.
- `/api/linear/import` — pull your Linear issues onto the board.
- `/api/linear/disconnect` — remove the connection.

Once connected and imported, **real Linear issues** appear on the board alongside the seeded rows.

## What is still preview

- **Seeded rows are static.** The default GitHub and Linear cards you see before importing are
  fixture data, not live issues.
- **Drag/drop does not persist.** Column moves are cosmetic and reset on reload.
- **No issue-workflow API.** There is no `issue-workflows` resource in the control-plane contract
  yet — you cannot create, start, retry, or query issue workflows programmatically. The board does
  not yet turn an issue into a sandbox or a run.
- **GitHub issues are not imported the way Linear is.** Only the Linear OAuth path brings in real
  external issues today.

## Related

- [Creating sandboxes](/docs/guides/creating-sandboxes) — the sandbox flow issue workflows are meant
  to feed into.
- [What ships today](/docs/introduction/what-ships-today) — the honest status of every surface.
