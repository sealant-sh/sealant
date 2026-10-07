---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A refused connected account says which provider it is about, in a stable code:

- `workspace.credentials.put()` and a create that names an account answer `404` with
  `code: "connected-account-missing"` for an account the person cannot name, and `409` with
  `code: "connected-account-invalid"` for one marked invalid or holding an unusable credential, each
  with `provider` (`claude`, `codex` or `github`). The messages are unchanged.
- `WorkspaceNotFoundError` takes an optional `code` and `provider`, and `WorkspaceConflictError` an
  optional `provider`; `connectedAccountRefusalCodes` lists the two codes.
- `SealantApiError` carries the body's stable code as `reason` and the account's `provider`, so a
  caller branches on `error.reason === "connected-account-missing"` and `error.provider` instead of
  the words or `error.cause`.
