# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.155@sha256:96bc1d3179acfd24f6fb7c481d4a798a782ea5fdbc108a3660960b375c98e6ac /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.155@sha256:96bc1d3179acfd24f6fb7c481d4a798a782ea5fdbc108a3660960b375c98e6ac /usr/local/bin/socat /usr/local/bin/socat
