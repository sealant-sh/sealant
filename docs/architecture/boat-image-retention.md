# Boat image retention

sealant builds each Boat environment once per Boat account and keeps it as a Boat saved snapshot
(`native_publications`, state `ready`). Boat includes ten per account and bills each extra one by
the day. Every environment change, every sealant upgrade that changes the build recipe and every
purge used to leave one behind. The worker now removes, per account, the ones no workspace can use
any more (`BoatNativeCatalogService.reap`, scheduled in `apps/worker/src/workers/workspaces.ts`).

## What "can still be used" means

A launch finds its image by exact key: the account's deployment, the image scope (owner or resource
domain), and the plan (`recipeHash`, `assetsHash`, `runtime`, `platform`) that this sealant computes
from the workspace's spec. A stopped Boat workspace has no VM; starting it again (a restart, or
Mend's resume, which creates a workspace from the captured files with the same environment) plans
its spec again. So an image is kept when any of these holds, checked in
`NativePublicationRepo.retire` under the publication's row lock:

1. **A run holds it.** Any consumer pin not released: a build in flight (the pin is taken at
   reserve), a launch, a running workspace or standby, a stop, a retained or unknown executor.
2. **It is wanted.** Its key is one this sealant plans, now, for the latest launch of a workspace
   that can still start in this account (`NativePublicationRepo.startable`): not archived, and
   queued, running, ready, or stopped or failed within `SEALANT_BOAT_IMAGE_RESUME_DAYS` (14). After
   a sealant upgrade that changes the recipe, a stopped workspace wants the new key, so the old
   image is no longer wanted. Only Boat workspaces count: every create has an image scope whatever
   its runtime, so a workspace counts only when its latest launch resolved to Boat (or has not
   resolved yet and asks for `boat` or `auto`) and Boat can launch its spec. A Docker workspace, or
   one Boat refuses (a custom base image, host directories, Arch, Fedora), is never planned here.
3. **A build of its scope is queued or running.** That job's spec was not read when the wanted keys
   were, so nothing of its scope is removed meanwhile.
4. **Something used it recently.** It became ready, or a run was pinned to it or released it, within
   `SEALANT_BOAT_IMAGE_MIN_AGE_HOURS` (24): a rolled-back sealant still finds its images.

If any counted workspace's spec cannot be planned, or there are more than 20,000 of them, the pass
removes nothing. A spec that no longer parses cannot launch and is ignored.

## Bounds

A rebuild costs a person a few minutes, once; an extra image costs $0.056 a day and, inside the
allowance, a slot another environment may need. The old rule (keep the ten newest plans per scope,
nothing younger than seven days) predates per-organization accounts and kept up to ten images per
person, more than an account's allowance. Wanted images are kept however many there are; the bounds
only decide how long an image nothing is about to use stays: 14 days after its workspace stopped,
and a day after its last use.

## What is never touched

Retention reads only this install's `native_publications` of the account's deployment, and the
builder deletes only a snapshot its own journal recorded under its own builder owner. It never lists
Boat's snapshots, so another install's images (another deployment), another stored account's images
over the same Boat account, and a full check's snapshot (`sealant-key-proof-*`, removed by its own
sweep) are out of its reach. An account whose removal was asked is skipped, and `retire` refuses
under the account row's share lock: the removal deletes its images itself. Quarantined builds
(including a reopened one waiting for its next launch) are not images and are left alone.

## Removal

Removal is the catalog's existing path, the one an account removal and an operator withdrawal use:
`retiring` is recorded first (no launch uses the image from then), a `remove` claim is taken, the
builder records the removal intent in its journal, deletes the snapshot and waits for Boat's `GET`
to answer 404, then the row becomes `removed`. A failure (a lost reply, Boat refusing) leaves the
row `quarantined` with `native-removal-pending`, which the journal sweep and the next pass retry: a
snapshot Boat already deleted reads 404 and is recorded removed. A process that dies after recording
keeps its claim for 30 minutes, then the next pass takes it over. A launch of an environment whose
image is being removed waits, as for a build in progress: reserve answers `publication-removing`,
the catalog answers `publication-pending`, and the build job tries again until the removal is
recorded, then builds the image again. It waits as long as the removal takes: seconds normally,
until the next journal sweep after a failed delete, up to the 30-minute claim after a worker died
mid-removal.

Schema: none changed. A rolled-back sealant reads every row this one writes.
