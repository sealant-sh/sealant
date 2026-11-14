---
"@sealant/api-contracts": patch
---

A refusal never quotes the value it refused (SLNT-960). `describeRequestIssue`, behind every
`400 RequestRefusedError`, now says only words that existed before the request did: declared field
names, array positions, a check's `expected` and `message` annotations, and its own wording. Text a
check returns while decoding is said only when the check declares it with the new
`refusalWords(...)` annotation, as one of those strings exactly or matching one of those patterns
whole; anything else reads "is invalid". Since 0.39.0 the old guard, which looked for the value in
the check's words, had not worked: on Effect 4 an issue holds the value only when the parse asks for
it. No check in the contract quoted its input, so no refusal did. `RequestRefusedError` keeps its
tag, status and shape.
