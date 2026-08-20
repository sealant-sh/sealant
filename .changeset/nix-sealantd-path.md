---
"@sealant/sdk": patch
---

Nix-family workspace images boot again. The Containerfile set `ENTRYPOINT ["sealantd", "boot"]`
— exec form with a bare name, resolved against the image's `PATH` — but `nixos/nix` ships only
its profile dirs there, so every nix workspace died at container init with
`exec: "sealantd": executable file not found in $PATH` before ever reaching ready. The
entrypoint is now the absolute `/usr/local/bin/sealantd`, and both render paths (distro and
custom base) prepend `/usr/local/bin` to `PATH` so the other baked binaries (the docker CLI,
socat, and anything sealantd resolves by name in-container) work on bases that don't include it.
