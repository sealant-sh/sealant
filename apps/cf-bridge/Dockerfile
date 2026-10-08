# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.153@sha256:6f5e63904c2812ce7ca4be4f5faba7974c2cb9d5dbce2a919e9ac2fab62a5ae9 /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.153@sha256:6f5e63904c2812ce7ca4be4f5faba7974c2cb9d5dbce2a919e9ac2fab62a5ae9 /usr/local/bin/socat /usr/local/bin/socat
