---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Add `CreateOptions.imageScopeId` for image reuse within an existing authorized resource domain.
Omitting it selects the authenticated owner. Workspace reads and image inspection now report tagged
OCI, MicroVM, or native snapshot publications. The SDK exposes these through `publication()` and
launch and inspection results. Unsupported Boat inputs return stable refusal codes. Boat execution
remains unavailable until its production capability is verified.
