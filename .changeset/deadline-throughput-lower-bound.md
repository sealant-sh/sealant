---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Deadline preservation no longer stops a MicroVM early on an idle interval's throughput. A reading of
uploaded bytes over the time between two sweeps measures the link only when the capture queue held
work at both ends of that interval; any other reading now only raises the estimated rate, never
lowering it under the previous estimate or the assumed 1 MiB/s. On a one-hour MicroVM, a reading of
140 KB/s taken three minutes in (the uploader idle most of the interval) put the estimate for 780 MB
at 6890 s and started the final drain at once; the same upload then ran at about 80 MB/s. The
sample's pending bytes are kept beside it (`upload_sample_pending_bytes`).
