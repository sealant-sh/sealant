---
"@sealant/sdk": minor
---

Export the Effect-native core at the `@sealant/sdk/effect` subpath. Effect-end-to-end consumers get
the contract-derived control-plane client as a service (`SealantApiClient` +
`sealantApiClientLayer`), one operation effect per contract endpoint, the managed runtime
(`makeSdkRuntime`), and the typed contract errors on the failure channel — instead of wrapping the
Promise facade. The README's "will be reachable" promise is now true.
