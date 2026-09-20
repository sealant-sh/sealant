---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Two faults in the MicroVM image builder, found by its first run against AWS (server-side; the
packages ride the release train). It looked images up and deleted them by name, where the platform
takes an image ARN, so every build failed at its first lookup with "Invalid ARN format". And it sent
the plan hash as the create request's `clientToken`: a plan built again after its image was deleted
replayed a token the platform had already completed, and that create sat in `CREATING` for the whole
build timeout with no build running. The name is now completed to an ARN from the build role's
account, and the token is one per build attempt. An opt-in live spec
(`SEALANT_MICROVM_BUILT_IMAGE_E2E=1`) builds a customised blueprint, boots it and checks inside the
VM.
