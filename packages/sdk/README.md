# @sealant/sdk

The fluent public SDK for Sealant — **create a sandbox, run a harness, replay the record.**

```ts
import { Sealant, opencode } from "@sealant/sdk";

const sealant = new Sealant({ baseUrl: "http://localhost:8080" });

const sandbox = await sealant.sandboxes.create({
  repository: "github.com/acme/billing-service",
  harness: opencode(),
});

const run = await sandbox.harness.run("Round invoice totals once, after applying the discount.");

await run.record.replay();
```

## Forward your local logins

Opt a sandbox into your existing tool logins so the agent inside is authenticated **as you** — no
`gh auth login` / `claude /login` dance inside the box:

```ts
const sandbox = await sealant.sandboxes.create({
  repository: "github.com/acme/billing-service",
  harness: claudeCode(),
  forward: ["gh", "claude-code"], // capture host tokens at create time → sandbox runtime env
  env: { MY_FLAG: "1" }, // explicit escape hatch; an explicit key wins over a forwarded one
});
```

Each id captures a **scoped auth token on your machine** and injects it as the runtime env var the
CLI already honors — no credential files are copied and nothing is baked into the image:

| `forward` id    | Captured on your machine                                              | Injected env var(s)                                            |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `"gh"`          | `gh auth token`                                                      | `GH_TOKEN`                                                    |
| `"claude-code"` | `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from your env | the same var(s)                              |
| `"codex"`       | `OPENAI_API_KEY` from your env, or the api-key field of `~/.codex/auth.json` | `OPENAI_API_KEY`                                      |

Notes:

- **Opt-in and non-fatal.** A tool you aren't logged into is skipped with a `console.warn` telling you
  how to fix it (e.g. run `gh auth login`, or `claude setup-token` and export `CLAUDE_CODE_OAUTH_TOKEN`);
  sandbox creation still succeeds.
- **Tokens, not whole configs.** Only a scoped token is forwarded, so the blast radius is one
  credential — not your entire `~/.config`. Forwarding full settings dirs (MCP servers, `config.toml`)
  is a later, opt-in feature.
- **Subscription OAuth is intentionally not file-copied.** Copying codex's ChatGPT `auth.json` rotates a
  single-use refresh token (can log *you* out), and a copied claude `.credentials.json` 401s within
  hours on another machine — so use `claude setup-token` / an API key for those.
- The forwarded token travels in the create request and lands in `runtime.env`. On a single-owner
  localhost deployment that's fine; treat the control plane as trusted with these tokens.

## Design

- **Plain-Promise facade over an Effect core.** The default export is ordinary `async`/`await`. The
  Effect-native core (services, `Stream`s, typed errors) will be reachable via the `@sealant/sdk/effect`
  subpath for power users.
- **Decoupled public types.** The types in [`src/types.ts`](src/types.ts) are hand-written and kept
  independent of the Effect-core and `@sealant/telemetry` internal shapes, so the public surface stays
  stable across internal change. The whole surface is typed now, including operations not yet
  implemented (those reject with `SealantNotImplementedError`).
- **Harness-neutral.** `opencode()`, `codex()`, `claudeCode()`, and `customHarness()` are thin client
  values describing how to invoke a harness one-shot.

## Status

Scaffold. The public surface compiles and the harness factories are real; the client operations are
typed stubs pending the implementation phases (Effect core → `create()` → `harness.run()` →
`record.replay()`). See the SDK build plan for the phased sequence.
