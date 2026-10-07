# The one runtime class this bridge launches: Cloudflare's sandbox base plus the static sealantd
# daemon (and its socat relay binary) from the released image — the same binary every other
# runtime family boots. Images are fixed at deploy time on Cloudflare, so per-blueprint image
# builds do not apply here; the launch request's `image` field is recorded, not honored.
FROM docker.io/cloudflare/sandbox:next
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.152@sha256:afea9ce8cb78562de2659ff0c30c805ac31c99992e41b680fb62a194941d4e6f /usr/local/bin/sealantd /usr/local/bin/sealantd
COPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd-next:0.20.0-next.152@sha256:afea9ce8cb78562de2659ff0c30c805ac31c99992e41b680fb62a194941d4e6f /usr/local/bin/socat /usr/local/bin/socat
