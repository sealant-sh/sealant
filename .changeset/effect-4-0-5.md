---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

The SDK and the contracts run on stable Effect: their peer dependency is `effect` `^4.0.5` (was
`>=4.0.0-beta.85 <5`). Effect 4.0.0 moved the HTTP modules out of `effect/unstable/*` and removed
the old paths, so the packages built against the beta failed to load beside Effect 4.0.x
(`ERR_MODULE_NOT_FOUND .../effect/dist/unstable/httpapi.js`) while the old peer range let a package
manager pair them without a warning. The built packages now import `effect/http` and
`effect/http-api`.

A consumer on an Effect 4 beta or release candidate moves to Effect 4.0.5 or later with this
release; the narrowed range keeps a beta from being paired with it. The SDK's surface, its contract
errors and the wire format are unchanged.
