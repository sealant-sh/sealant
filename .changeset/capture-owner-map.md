---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

A capture source takes an owner map, for executors where each person is a Linux user of their own
(Mend's per-person layout):

- `create({ source: { kind: "capture", …, ownerMap: { gid, worktreeUid, people: [{ id, uid }] } } })`
  reaches the workspace daemon as `SEALANT_CAPTURE_OWNER_MAP`. Its restore gives each listed
  person's saved directory (`<harnessHome>/people/<id>/`) to their uid and the worktree to the
  group, and a map that names anyone makes the executor a per-person one: no no-new-privileges, so
  every person's `sudo` works. Without a map nothing changes.
- Checked by the SDK and the control plane alike: `gid` 40000, uids in 40001–49999, ids that are one
  directory name, no id or uid twice, at most 256 people. Refused on Cloudflare. A launch on an
  image whose probe does not report `restore.owner_map` fails with `owner-map-unsupported` before
  anything starts.
- `@sealant/api-contracts/capture-owner-map` holds the shape, the checks (`captureOwnerMapProblems`)
  and the daemon's encoding (`encodeCaptureOwnerMap`).
