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

From the repo root:

```bash
[ -f .env ] || cp .env.example .env               # the defaults point at local infra
docker compose up -d --wait postgres              # Postgres on :5433
pnpm db:migrate
pnpm --filter @sealant/api dev > /tmp/sealant-api.log 2>&1 &   # :4000
pnpm --filter @sealant/web dev > /tmp/sealant-web.log 2>&1 &   # :3000
pnpm exec playwright install --only-shell chromium               # once per Playwright version
```

Wait until `curl -s http://localhost:3000/` answers. Vite listens on `localhost`, not `127.0.0.1`.

Skip `db:seed`: it only creates the SDK's default owner, and it needs `DATABASE_URL` set by hand.
Start the worker and SSH gateway (`docker compose --profile apps up -d --build`) only when the
change involves building or running a workspace.

**Done when** `http://localhost:3000/` answers and the API log shows no errors.

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

Stop the two dev servers you started, then `docker compose down`. Add `-v` to drop the local
database, including the verify account.

## 5. Report

Post the verdict on the PR with the screenshots attached, one `--attach` per image:

```bash
gh pr comment <number> --body-file <verdict.md> \
  --attach /tmp/sealant-verify/workspaces.png --attach /tmp/sealant-verify/settings.png
```

The verdict names the commit, what you did, what each screenshot shows, and anything you couldn't
check.
