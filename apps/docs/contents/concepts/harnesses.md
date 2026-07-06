---
title: Harnesses
description:
  The bring-your-own-harness model — what a harness is, the shipped options, and how to run a custom
  one.
---

Sealant does not ship an agent or a model. It ships the environment and the record, and you bring
the tool that does the work. That tool is the **harness**.

A harness is whatever drives the coding work inside a [workspace](/docs/concepts/workspaces): a
coding agent, a CI worker, your own loop, or a plain command. Sealant's job is to give it a real
repository to work in and to turn its execution into an
[execution record](/docs/concepts/execution-records). What the harness _is_ stays your choice.

## A harness is one-shot against a prompt

The model is deliberately thin. A harness is described by an id and how to invoke it once against a
prompt. When you start a run, Sealant executes that invocation inside the workspace and records
everything it does. One invocation is one [run](/docs/concepts/execution-records); one run produces
one record.

Because a harness is just "how to invoke this thing," Sealant stays agnostic — it never needs to
understand the agent's internals, only how to launch it and watch it.

## Shipped harnesses

The workspace builder (`/workspaces/new`) lets you pick one of three harnesses when you create a
workspace:

| Harness     | id            | One-shot invocation     |
| ----------- | ------------- | ----------------------- |
| OpenCode    | `opencode`    | `opencode run <prompt>` |
| Codex       | `codex`       | `codex exec <prompt>`   |
| Claude Code | `claude-code` | `claude -p <prompt>`    |

> OpenCode is the only harness exercised end to end today. The Codex and Claude Code invocation
> forms are the expected headless shapes but are still pending live verification against the baked
> workspace image. If you rely on one of the latter two, confirm the one-shot command against your
> image.

## Custom harnesses

Anything you can install and invoke can be a harness. Through the
[preview SDK](/docs/reference/sdk), `customHarness` is the escape hatch: you supply the id, how to
build the one-shot command from a prompt, and optionally how to install and launch the tool.

```ts
import { Sealant, customHarness } from "@sealant/sdk";

const myHarness = customHarness({
  id: "my-agent",
  executable: "my-agent",
  invoke: (prompt) => ["run", "--prompt", prompt],
  install: { packages: ["my-agent"] },
});
```

This is how you bring an agent that is not one of the three built-ins — your own binary, a fork, or
a wrapper script. As long as it runs one-shot against a prompt, Sealant can drive it and record it.

## How a harness relates to a run

The relationship is straightforward:

1. You bake a harness into the workspace spec (build time).
2. You start a run with a prompt.
3. Sealant executes the harness's one-shot invocation inside the ready workspace.
4. Everything the harness does becomes an [execution record](/docs/concepts/execution-records).

> The [SDK](/docs/reference/sdk) is a preview package (`@sealant/sdk`; first npm release in flight).
> Today it is consumable only inside the monorepo, and runs are started through it or the
> [HTTP API](/docs/reference/http-api) (`POST /v1/runs`) — blocking via `harness.run` or
> non-blocking via `harness.start`. The interactive `harness.session` form exists in the typed
> surface but is not wired end to end yet.

## Related

- [Workspaces](/docs/concepts/workspaces) — where the harness runs.
- [Execution records](/docs/concepts/execution-records) — what a harness run produces.
- [Creating workspaces](/docs/guides/creating-workspaces) — picking a harness in the builder.
- [SDK](/docs/reference/sdk) and [HTTP API](/docs/reference/http-api) — the programmable surface.
