---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A Claude or Codex API key can send this login's requests to a compatible endpoint, such as a company
gateway. `connect({ endpoint })` takes the endpoint's base URL: an absolute `http:` or `https:` URL
with a host, and no user name, password, query string or fragment. A trailing slash is dropped.
`EndpointUrl` in `@sealant/api-contracts` is that parse, and `parseEndpointUrl` answers the reason a
URL is refused. The endpoint is stored sealed with the key. With an endpoint, the key may be any
value without spaces, for an endpoint that takes no real key; an Admin key is still refused. An
endpoint with any other login is refused with a `400`, and a reconnect without one removes it.

`ConnectedAccount.login` names the endpoint's host as `endpointHost`, never its URL. A placement
receipt's `login` carries the URL as `baseUrl`; nothing in the home holds it, so the harness's
launch sets it. A launch refuses a Codex key with an endpoint with `connected-account-unsupported`,
since it would write the key alone, and workspace create skips one a profile binds. Inference sends
an exchange on such a key to its endpoint and nowhere else, and a key the endpoint refuses is
reported as refused by the endpoint at its host. A control plane reports all of this as
`features().connectedAccountEndpoints`; the SDK sends `endpoint` only to one that does, and
otherwise throws `connected-account-endpoints-unsupported` before sending anything.
