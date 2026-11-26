# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.21.0-next.215@sha256:e1766fa62454415f2ec39a3fa80260c1e103bf93ffecb4ac3fdd1f86c12840e1 /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.21.0-next.215@sha256:e1766fa62454415f2ec39a3fa80260c1e103bf93ffecb4ac3fdd1f86c12840e1 /usr/local/bin/socat /usr/local/bin/socat
