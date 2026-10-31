# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.21.0-next.180@sha256:f3a2855e210d7357a12c466fac1fc180a4b4d8ab021e4c6f9812b2b2755214fc /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.21.0-next.180@sha256:f3a2855e210d7357a12c466fac1fc180a4b4d8ab021e4c6f9812b2b2755214fc /usr/local/bin/socat /usr/local/bin/socat
