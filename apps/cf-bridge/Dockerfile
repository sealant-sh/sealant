# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.142@sha256:5983d0b8a79155b78e8b0f353c5be97f8487d38bda6bc9768982b246bcc7b1e6 /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.142@sha256:5983d0b8a79155b78e8b0f353c5be97f8487d38bda6bc9768982b246bcc7b1e6 /usr/local/bin/socat /usr/local/bin/socat
