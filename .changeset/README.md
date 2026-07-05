# Changesets

Versioning for the published packages (`@sealant/sdk`, `@sealant/api-contracts` — a fixed group:
they always share one version). Everything else in the workspace is private and ignored.

Flow:

1. With a change worth releasing, run `pnpm changeset` and commit the generated file.
2. On merge to `main`, the Version workflow opens/updates a "Version Packages" PR.
3. Merge that PR, then push a `vX.Y.Z` tag — the Release workflow publishes to npm (the tag is the
   version authority; package.json versions are synced from it at publish time) and ships the
   Docker/self-host release.

See <https://github.com/changesets/changesets> for details.
