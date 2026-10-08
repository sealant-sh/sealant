# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.154@sha256:4415bf9075805453e069eaff2f624a44b5bf7b210ae4cf327bb54d3d5695d52d /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.154@sha256:4415bf9075805453e069eaff2f624a44b5bf7b210ae4cf327bb54d3d5695d52d /usr/local/bin/socat /usr/local/bin/socat
