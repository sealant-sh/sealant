---
"@sealant/sdk": patch
---

`nix` workspace images now carry the person layout and can run one Linux user per person. The image
makes its account files writable, installs a setuid `sudo` with its own sudoers and PAM file, keeps
packages in `/nix/var/nix/profiles/default`, and starts the nix daemon before `sealantd boot`.
People's nix commands go through that daemon (`NIX_REMOTE=daemon`).
