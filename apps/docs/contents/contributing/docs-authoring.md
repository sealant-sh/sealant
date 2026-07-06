---
title: Docs authoring
description:
  How this site is built, the frontmatter and navigation conventions, and the honesty rule every
  page follows.
---

This is the fumadocs site for Sealant. If you're adding or editing a page, this is the whole
convention set.

## Where content lives

All authored content is Markdown/MDX under `apps/docs/contents`, organized by top-level section:

```text
apps/docs/contents/
├── index.md
├── introduction/
├── getting-started/
├── guides/
├── reference/
├── concepts/
└── contributing/
```

Each directory has a `meta.json` that sets the section title and page order:

```json
{
  "title": "Guides",
  "pages": ["github-app", "ssh-access", "creating-workspaces", "..."]
}
```

Adding a page means adding a Markdown file **and** listing its filename (no extension) in the
directory's `meta.json` — a file that exists but isn't listed in `meta.json` won't appear in the
nav. `apps/docs/src/lib/source.ts` loads all of it under the `/docs` base URL, so a page at
`contributing/docs-authoring.md` is served at `/docs/contributing/docs-authoring`.

## Frontmatter

Every page starts with:

```yaml
---
title: Short page title
description: One sentence — shows in nav hover and search results.
---
```

That's it — no `slug`, `status`, or `owner` fields. (Older archived pages under `docs/archive/` use
a heavier frontmatter shape from before this site existed; don't carry that convention forward.)

## Plain Markdown vs MDX

Use `.md` for ordinary prose pages. Reach for `.mdx` only when a page actually needs fumadocs
components — `Callout`, `Card`/`Cards`, `Accordion`/`Accordions`, `Steps`, `Tabs`, `Files` — and
import exactly the ones you use at the top of the file:

```mdx
import { Card, Cards } from "fumadocs-ui/components/card";
```

Don't reach for components as decoration. Most pages here are `.md` for a reason — plain prose,
tables, and code blocks read faster than nested cards.

## Voice and structure

- Second person, plain, direct — no marketing language.
- Every command is copy-pasteable and uses real env var names, ports, and paths — verify them
  against source before writing, don't guess.
- Cross-link other docs pages with absolute site paths: `/docs/guides/ssh-access`, not a relative
  path or a bare filename.
- A page is as long as it needs to be. A focused 80-line page beats a padded 300-line one.

## The honesty rule

This is the non-negotiable one: **never document unshipped surface as if it were real.**

Sealant's docs describe a system that is still being built. Concretely:

- If a feature is mock or static-data-backed in the UI (for example, some
  repository/profile/registry views), say so plainly rather than writing instructions as if it
  persisted anything.
- If something is a preview (the SDK, the runs review surface), label it as preview and say what
  that means in practice — what works end to end today versus what's typed but not wired up.
- If a security/auth property doesn't exist yet (there are no API tokens; there is no bearer-auth
  enforcement on the control-plane API; identity is currently a passed-through `ownerUserId`), state
  that plainly wherever it's relevant instead of describing an auth model that doesn't exist.
- When you're not sure whether something is shipped, check the source under `apps/` and `packages/`
  before writing the page. Don't extrapolate from a README or a plan doc — those go stale.

## Salvage material

Docs written before this site existed — per-app and per-package references, architecture notes,
product plans — are archived at
[`docs/archive/docs-site`](https://github.com/sealant-sh/sealant/tree/main/docs/archive/docs-site).
Some of it is useful raw material (accurate module maps, env var lists); some of it describes plans
that were never built or have since changed shape. Treat it as a source to verify against the repo,
never as something to copy in directly.
