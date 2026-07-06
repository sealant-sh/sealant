---
title: Run your first workspace
description:
  Create a workspace in the web app, watch it build, and connect over SSH, VS Code, or Cursor.
---

This walkthrough takes you from a fresh install to a live workspace you can open in your editor. It
assumes Sealant is already running — if not, start with [Install](/docs/getting-started/install).

## 1. Sign up

Open **[http://localhost:3000](http://localhost:3000)** and register an account. Sign in when you're
done.

## 2. Add an SSH public key

You connect to running workspaces over SSH, so Sealant needs your public key on file first.

Go to **Settings → SSH keys**, paste the contents of your public key (for example
`~/.ssh/id_ed25519.pub`), give it a name, and save. You can add more keys later, or register one
inline while creating a workspace.

Each active public key maps to exactly one account, so the same key can't be shared across users.
For the full auth model, see [SSH access](/docs/guides/ssh-access).

## 3. Create a workspace

Click **New workspace** and fill in the essentials:

- **Source repository** — a raw Git URL, or a repository from a connected
  [GitHub App](/docs/guides/github-app) installation for private repos.
- **Ref** — the branch, tag, or commit to check out. GitHub App repositories default to the
  repository's default branch; raw Git URLs default to `main`.
- **Harness** — the coding agent to install in the workspace: **OpenCode**, **Codex**, or **Claude
  Code**.

Leave the rest at their defaults for now — runtime OS, shell, packages, and setup commands all have
sensible defaults, and the page shows a live preview of the workspace spec as you go. Submit to
start the build. For a tour of the advanced options, see
[Creating workspaces](/docs/guides/creating-workspaces).

## 4. Watch the build

You land on the workspace detail page. It shows the current **status**, build **attempts**, recent
**events**, and — once the image is published — the output image reference and digest. The build
clones your repository, installs the harness and packages, and publishes an image to the local
registry before the workspace goes **running**.

## 5. Connect

Once the workspace is running, connect over SSH. The username is `ws-` followed by the workspace id:

```bash
ssh -p 2222 ws-<workspace-id>@localhost
```

The workspace page has a **Copy SSH command** button with the exact id filled in. If you changed
`SEALANT_SSH_PORT` or `SEALANT_SSH_HOST` at install time, use those values instead.

To work in an editor, use **Open in VS Code** or **Open in Cursor** on the workspace page — both
open a remote session into the running workspace over the same SSH gateway. More detail in
[SSH access](/docs/guides/ssh-access).

## What's next

- Understand what a run produces in
  [Runs and execution records](/docs/guides/runs-and-execution-records).
- Learn the core model in [Workspaces](/docs/concepts/workspaces) and
  [Execution records](/docs/concepts/execution-records).

---

## Appendix: create a workspace with the HTTP API

The web app is the intended path, but the same lifecycle is available over the
[HTTP API](/docs/reference/http-api). This is useful for scripting or trying the API directly.

> Identity is temporary today: there are no API tokens and no bearer-auth enforcement. Requests
> carry an `ownerUserId` directly in the payload or query string, and this will change once real
> auth lands. Use the id of your web account (or the local default) for `ownerUserId`.

Create a workspace:

```bash
curl -X POST http://localhost:4000/v1/workspaces \
  -H 'content-type: application/json' \
  -d '{
    "ownerUserId": "<userId>",
    "registryId": "default",
    "repository": "sealant/workspaces/demo",
    "tag": "opencode",
    "spec": {
      "version": "1",
      "sources": {
        "workspace": {
          "kind": "git",
          "provider": "generic",
          "url": "https://github.com/example/repo",
          "ref": "main"
        },
        "inputs": []
      },
      "harness": { "id": "opencode" }
    }
  }'
```

A successful create returns `202` with a `workspaceId`. Poll its status:

```bash
curl "http://localhost:4000/v1/workspaces?ownerUserId=<userId>"
curl "http://localhost:4000/v1/workspaces/<workspaceId>"
```

Then, once the key from step 2 is registered and the workspace is running, connect with the same
`ssh -p 2222 ws-<workspace-id>@localhost` command as above.
