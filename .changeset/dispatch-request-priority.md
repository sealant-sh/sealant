---
"@sealant/sdk": minor
---

Accept a request priority callback in `SealantConfig`. The SDK evaluates the callback at each HTTP
request dispatch, so retained workspace, session and scope handles use the caller's current
priority. Explicit values and callbacks override operation defaults, including interactive control
defaults. Unset priority keeps the existing normal requests and interactive controls.
