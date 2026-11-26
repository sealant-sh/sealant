# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.21.0-next.217@sha256:788140b097756b8672b2514d0b379f317c79dcce4c8e45ec1c4cf9ba63b33fd3 /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.21.0-next.217@sha256:788140b097756b8672b2514d0b379f317c79dcce4c8e45ec1c4cf9ba63b33fd3 /usr/local/bin/socat /usr/local/bin/socat
