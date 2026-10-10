# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.157@sha256:b59b6e6ba1792f3a2ddf3cf02e12f415c4bf7e6888cbadaa4b61d7a8a6cdd3f5 /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.157@sha256:b59b6e6ba1792f3a2ddf3cf02e12f415c4bf7e6888cbadaa4b61d7a8a6cdd3f5 /usr/local/bin/socat /usr/local/bin/socat
