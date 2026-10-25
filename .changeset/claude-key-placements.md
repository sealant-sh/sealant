---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

A credentials put places a Claude API key into a home. The key is written alone, mode 0600 and owned
by the home's owner, at `<home>/.sealant/keys/<placementId>`, a directory reached through no
symbolic link, never into `.credentials.json` or anywhere under `.claude`. Any number of key files
sit beside a subscription's file, so a later put never changes the file a running Claude reads, and
a key file is never pinned. Prune, release, archive and the removal sweep remove a key file with its
placement. A put refuses a Claude key, in words, for `/root` and for a home whose key directory lies
in the run's working directory or a capture's harness home. A Claude key is still refused at `$HOME`
and in a launch.

A placement receipt's `login` says what it spends: `{ kind: "subscription" }`, or
`{ kind: "api-key", suffix, keyPath? }`. `keyPath` is the absolute path of a Claude key's file, for
an `apiKeyHelper` such as `cat <keyPath>`; a Codex key has no `keyPath`. A Codex key now reads as
`api-key` too. A refresh never writes into a key placement. The control plane reports
`features.connectedAccountApiKeys`, and the SDK reports it as `features().connectedAccountApiKeys`.
