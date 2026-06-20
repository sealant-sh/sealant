# @sealant/issues

Provider-neutral issue workflow imports and board state helpers.

This package normalizes GitHub and Linear issue payloads into Sealant issue workflow records. It
does not persist imported records or own provider credentials; API and sync boundaries can compose
these helpers with database repositories.

The web app owns the current Linear OAuth entrypoint under `/api/linear/*`. Those server routes keep
OAuth tokens in encrypted HttpOnly cookies and call `importLinearIssues` with a bearer token.
