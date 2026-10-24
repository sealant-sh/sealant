# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd:0.20.0@sha256:4833cf18b3977bdd1bfe056bab514c131581e58838f3f023295920a7d2583548 /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd:0.20.0@sha256:4833cf18b3977bdd1bfe056bab514c131581e58838f3f023295920a7d2583548 /usr/local/bin/socat /usr/local/bin/socat
