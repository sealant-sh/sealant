---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

`unreachable` (on `BoatAccount` and `BoatInstallKey`) now names only what Boat did not find where
the miss does not prove it gone: under a key without `account.read`, which cannot list its wallets.
Boat answers a personal key's read of a VM or a saved image whichever wallet a request names, so
under a key that can list its wallets a miss under every wallet is Boat's word that the object is
gone: such an image is recorded removed, and what was listed before is read again and leaves the
list. The field and its shape are unchanged, and it is `null` when nothing is listed. A saved image
made before sealant recorded wallets that Boat still holds is recorded in the wallet the account
creates in now, and image retention removes it once nothing uses it.
