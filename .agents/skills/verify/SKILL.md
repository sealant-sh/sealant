---
name: verify
description:
  Run sealant's stack locally, drive the web app signed in, and keep screenshots as evidence. Use to
  prove a change to the web app, API or SDK works beyond its tests, and for every UI change before
  its PR opens.
---

# Verify a sealant change

Prove the change by using it. For anything a person sees, the evidence is screenshots; a UI change
isn't verified until someone has looked at it.

## 1. Say what you expect to see

Before running anything, write down what the screen or response should show if the change works, and
what it would show if it didn't. If the change alters an existing screen, say which.

## 2. Start the stack

```bash
pnpm verify stack up                                # Postgres (:5433), migrated, API :4000, web :3000
pnpm exec playwright install --only-shell chromium  # once per Playwright version
```

`up` says ready only once the API has answered `/v1/system/setup-state` from the database and the
web app has served its page; its logs are under `.verify/logs/stack-*.log`. It creates `.env` from
`.env.example` when there is none. Ports already in use make it `blocked_by_prerequisite`.
`pnpm verify stack status` checks a stack it started.

Skip `db:seed`: it only creates the SDK's default owner, and it needs `DATABASE_URL` set by hand.
Start the worker and SSH gateway (`docker compose --profile apps up -d --build`) only when the
change involves building or running a workspace.

**Done when** `pnpm verify stack up` exits 0.

## 3. Drive it and take screenshots

`scripts/shot.mjs` signs in and screenshots pages. On an empty database it creates a local account
through the `/setup` wizard; after that it signs in as that account. Screenshots go to
`/tmp/sealant-verify/` (`SHOT_DIR` overrides).

For pages you can reach by URL:

```bash
node .agents/skills/verify/scripts/shot.mjs /workspaces=workspaces /settings=settings
```

For a flow, such as filling a form or opening a dialog, write a scratch script outside the repo that
imports the helpers by absolute path:

```js
import {
  withSignedInPage,
  open,
  shoot,
} from "/abs/path/to/sealant/.agents/skills/verify/scripts/shot.mjs";

await withSignedInPage(async (page) => {
  await open(page, "/workspaces");
  await page.getByText("New workspace").first().click();
  await shoot(page, "new-workspace");
});
```

Screenshot every state the change touches, including the empty and error states it adds. Then read
each PNG and check it shows what step 1 expected: a blank or half-rendered frame is a failed run,
not evidence.

When the change alters an existing screen, take the same shots on `main` too, so the PR shows before
and after.

**Done when** you have a screenshot of every state in step 1 and have looked at each one.

## 4. Stop the stack

`pnpm verify stack down` stops the dev servers and the Postgres service that `up` started, and
leaves a Postgres that was already running. The database volume stays, the verify account with it;
`docker compose down -v` drops it.

## 5. Report

Post the verdict on the PR with the screenshots attached, one `--attach` per image:

```bash
gh pr comment <number> --body-file <verdict.md> \
  --attach /tmp/sealant-verify/workspaces.png --attach /tmp/sealant-verify/settings.png
```

The verdict names the commit, what you did, what each screenshot shows, and anything you couldn't
check.
