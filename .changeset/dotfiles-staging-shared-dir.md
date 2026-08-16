---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Dotfiles archives now stage under the control-socket shared directory when the worker runs inside
the self-host compose stack. `docker run -v` resolves bind paths on the daemon's host filesystem, so
archives staged in the worker container's private tmpdir arrived as an empty mount and boot aborted
with "manifest.json: No such file or directory". The staging root now follows
`WORKSPACE_CONTROL_SOCKET_HOST_DIR` (`<dir>/_dotfiles/…`) — the one path the stack bind-mounts at
the same location on both sides — and host-run workers keep using the system tmpdir.
