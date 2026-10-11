---
"@sealant/sdk": patch
---

pacman on arm64 Arch images (in the build, and `pacman -S` in a workspace) installs from eight Arch
Linux ARM mirrors measured fast, in order, with the port's geo redirector last. The rootfs's own
mirrorlist names only the redirector, which stalled every database sync of a CI build ("failed to
synchronize all databases") and sends some networks to a mirror serving 30 KB/s. The rootfs download
falls back over the same mirrors (now also hu, gr and fr). Signature checking is unchanged.
