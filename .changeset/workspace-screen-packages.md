---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

The workspace package catalog knows what a screen needs: `tigervnc` (`Xvnc` and `vncpasswd`),
`xauth`, `xdpyinfo`, `openbox`, `chromium` and `fonts-dejavu`, under each family's own names. Fedora
installs `chromium` as `chromium-browser`, and the build links `chromium` to it. A catalog entry may
now name a family it cannot run on: `chromium` on Ubuntu 24.04 is a stub for the chromium snap, and
a workspace image runs no snapd, so creating an Ubuntu workspace that asks for it is refused with a
`400` that names the id, the family and the reason, and the image planner refuses it the same way.
