---
"@sealant/api-contracts": patch
"@sealant/sdk": patch
---

Registry repository names, tags and digests are held to the OCI grammar and refused otherwise, never
repaired. `GET /v1/registries/:id/tags` and `/manifest` now answer 400 for a `repository` or
`reference` outside it (`..`, `%2e`, `?`, `#`, a backslash, a scheme, uppercase, an empty segment),
and the registry client refuses the same before it builds a URL or a `docker` argument, keeps every
request on the registry's origin under `/v2/`, does not follow redirects, gives each request a
30-second deadline and reads at most 8 MiB of any answer. The local Docker image store holds names
to the same grammar, and `POST /v1/workspaces` answers 400 for a `repository` or `tag` outside it
instead of failing the build later. The SDK's generated repository slug and the plan coordinates
always satisfy the grammar (`.github` becomes `github`, `a..b` becomes `a-b`), and a prior publish
under a name the grammar refuses counts as nothing to reuse. `isOciRepository`, `isOciTag`,
`isOciDigest`, `isOciReference` and `toOciRepositoryComponent` are exported from
`@sealant/api-contracts`.
