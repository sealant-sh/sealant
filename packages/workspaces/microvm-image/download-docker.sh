#!/usr/bin/env bash
# Install the pinned Docker engine and CLI plugins into the Docker-capable image, for the
# architecture the builder runs on (aarch64 for the Lambda MicroVM image, x86_64 for the Boat
# image). The engine archive is Docker's static glibc-independent bundle. The plugins are static
# Go binaries from their upstream release pages, so none of these files depend on Alpine/musl.
set -euo pipefail

DOCKER_VERSION="29.8.1"
BUILDX_VERSION="0.37.1"
COMPOSE_VERSION="5.5.1"

case "$(uname -m)" in
  aarch64)
    DOCKER_ARCH="aarch64"
    DOCKER_SHA256="667395fbffab52901b80181dfbb39ea76da2fbd7642c4fbddd24e42146b07b48"
    BUILDX_ARCH="arm64"
    BUILDX_SHA256="e5cc9fe3bbff5cbc91230981f7860e06076110730a2db997082652199042a1f2"
    COMPOSE_ARCH="aarch64"
    COMPOSE_SHA256="732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7"
    ;;
  x86_64)
    DOCKER_ARCH="x86_64"
    DOCKER_SHA256="d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70"
    BUILDX_ARCH="amd64"
    BUILDX_SHA256="9447199cdb435f25880548343c128a4b6650e8891ee598905d8d29d39a8e359b"
    COMPOSE_ARCH="x86_64"
    COMPOSE_SHA256="db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576"
    ;;
  *)
    printf 'Docker payload installation requires an aarch64 or x86_64 builder, not %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

WORK="$(mktemp -d -t sealant-docker.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

fetch() {
  local url="$1" destination="$2" sha256="$3"
  curl --fail --silent --show-error --location --retry 3 \
    --proto '=https' --tlsv1.2 "$url" --output "$destination"
  printf '%s  %s\n' "$sha256" "$destination" | sha256sum --check --status
}

ENGINE_ARCHIVE="$WORK/docker.tgz"
fetch \
  "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VERSION}.tgz" \
  "$ENGINE_ARCHIVE" \
  "$DOCKER_SHA256"
tar -xzf "$ENGINE_ARCHIVE" -C "$WORK"
for binary in containerd containerd-shim-runc-v2 ctr docker dockerd docker-init docker-proxy runc; do
  [[ -f "$WORK/docker/$binary" ]] || {
    printf 'Docker engine archive is missing %s\n' "$binary" >&2
    exit 1
  }
  install -m 0755 "$WORK/docker/$binary" "/usr/local/bin/$binary"
done

PLUGIN_DIR="/usr/local/lib/docker/cli-plugins"
install -d -m 0755 "$PLUGIN_DIR"
fetch \
  "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${BUILDX_ARCH}" \
  "$WORK/docker-buildx" \
  "$BUILDX_SHA256"
fetch \
  "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}" \
  "$WORK/docker-compose" \
  "$COMPOSE_SHA256"
install -m 0755 "$WORK/docker-buildx" "$PLUGIN_DIR/docker-buildx"
install -m 0755 "$WORK/docker-compose" "$PLUGIN_DIR/docker-compose"

# These checks prove that the engine bundle contains both client and daemon, and that the CLI
# discovers both plugins. They do not start dockerd during the image snapshot.
docker --version | grep -F "version ${DOCKER_VERSION}"
dockerd --version | grep -F "version ${DOCKER_VERSION}"
docker buildx version | grep -F "v${BUILDX_VERSION}"
docker compose version | grep -F "v${COMPOSE_VERSION}"
