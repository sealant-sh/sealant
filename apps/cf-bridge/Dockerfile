# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.21.0-next.203@sha256:8597fd60baccd4f884ed8d454d08020ee238d6425b616bba8d9ec81a95c91924 /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.21.0-next.203@sha256:8597fd60baccd4f884ed8d454d08020ee238d6425b616bba8d9ec81a95c91924 /usr/local/bin/socat /usr/local/bin/socat
