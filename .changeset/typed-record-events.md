---
"@sealant/api-contracts": minor
"@sealant/sdk": minor
---

Typed record-event taxonomy. `@sealant/api-contracts` now exposes the payload schemas behind every
recorded event kind (process, io, file, network, runtime, and loss events — the stored jsonb shape:
uint64s as decimal strings, protocol enums as numbers) plus `decodeRecordEventPayload`, a total
decoder that folds a wire `(kind, ref)` pair into a discriminated union and degrades to an `unknown`
case instead of throwing. The SDK's `TimelineEntry` is now that discriminated union: switch on
`kind` and `data` narrows to the typed payload, with `{ kind: "unknown", rawKind, data }` as the
forward-compatibility case for kinds newer than the SDK. No new event kinds were added; a
file-read/open event is noted as future work.
