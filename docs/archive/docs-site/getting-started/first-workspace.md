---
title: Run Your First Workspace
slug: /getting-started/first-workspace
status: draft
owner: engineering
updated: 2026-03-31
---

This walkthrough runs the minimal local workspace lifecycle through API + worker.

## Prerequisites

- local setup completed from `getting-started/local-development.md`
- API and worker are running

## 1) Create a workspace request

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
      "harness": {
        "id": "opencode"
      }
    }
  }'
```

Expected result: `202` response with a `workspaceId`.

## 2) Poll workspace status

```bash
curl "http://localhost:4000/v1/workspaces?ownerUserId=<userId>"
curl "http://localhost:4000/v1/workspaces/<workspaceId>"
```

Common statuses include `queued`, `running`, `succeeded`, and `failed`.

## 3) Verify image in registry

```bash
curl "http://localhost:4000/v1/registries/default/tags?repository=sealant/workspaces/demo"
```

## 4) Troubleshoot quick checks

- `404 Unknown registry`: verify `registryId` matches `REGISTRY_NAME` (default `default`).
- `502` from create workspace: check RabbitMQ reachability/config.
- `failed` status: inspect worker logs and stored error payloads.
