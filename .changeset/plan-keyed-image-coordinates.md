---
"@sealant/workspaces": minor
"@sealant/worker": patch
---

Workspace images are published under plan-keyed coordinates: one repository per OS family
(`sealant-workspace-<family>`) and one tag per plan hash (`plan-<12 hex>`). The image is a pure
function of the rendered Containerfile, so every workspace with the same plan now shares one name as
well as one image, and a registry holds one image per distinct plan instead of one per workspace.
Before, the SDK's per-create `<mount basename>:sdk-<random>` name meant the shared image lived under
whichever workspace built it and every rebuild landed under a new repository; one deployment
accumulated ~190 `wt-<id>` repositories holding the same few images until its registry filled and
every launch failed. The build job's own `repository`/`tag` still record what the client asked for;
the plan-hash reuse check now HEADs the tag a prior job actually published.
