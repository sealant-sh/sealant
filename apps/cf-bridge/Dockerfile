# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.150@sha256:c292d27c4d9c853e87c58eb31472eac8e920c9c5e79e8af60a9a4d9aa7a9b138 /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.150@sha256:c292d27c4d9c853e87c58eb31472eac8e920c9c5e79e8af60a9a4d9aa7a9b138 /usr/local/bin/socat /usr/local/bin/socat
