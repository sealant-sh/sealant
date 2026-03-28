---
title: Run Your First Sandbox
slug: /getting-started/first-sandbox
status: draft
owner: engineering
updated: 2026-03-28
---

# Run Your First Sandbox

This walkthrough runs the minimal local sandbox lifecycle through API + worker.

## Prerequisites

- local setup completed from `getting-started/local-development.md`
- API and worker are running

## 1) Create a sandbox request

```bash
curl -X POST http://localhost:4000/v1/sandboxes \
  -H 'content-type: application/json' \
  -d '{
    "registryId": "default",
    "repository": "sealant/workspaces/demo",
    "tag": "opencode",
    "spec": {
      "source": "https://github.com/example/repo",
      "harness": "opencode",
      "os": "nix",
      "target": {
        "runtime": "docker"
      }
    }
  }'
```

Expected result: `202` response with a `sandboxId`.

## 2) Poll sandbox status

```bash
curl "http://localhost:4000/v1/sandboxes?ownerUserId=<userId>"
curl "http://localhost:4000/v1/sandboxes/<sandboxId>"
```

Common statuses include `queued`, `running`, `succeeded`, and `failed`.

## 3) Optional low-level job inspection

If you have a job id:

```bash
curl "http://localhost:4000/v1/workspace-build-jobs/<jobId>"
```

This route is internal/operator-oriented compared to the primary sandbox lifecycle routes.

## 4) Verify image in registry

```bash
curl "http://localhost:4000/v1/registries/default/tags?repository=sealant/workspaces/demo"
```

## 5) Troubleshoot quick checks

- `404 Unknown registry`: verify `registryId` matches `REGISTRY_NAME` (default `default`).
- `502` from create sandbox: check RabbitMQ reachability/config.
- `failed` status: inspect worker logs and stored error payloads.
