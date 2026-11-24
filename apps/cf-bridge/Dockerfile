# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.21.0-next.209@sha256:1e0bfcc2a9bee0cac7d735a5a44b9cae86d8839ad508616584137c52a24a0008 /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.21.0-next.209@sha256:1e0bfcc2a9bee0cac7d735a5a44b9cae86d8839ad508616584137c52a24a0008 /usr/local/bin/socat /usr/local/bin/socat
