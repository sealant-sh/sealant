#!/bin/sh
# Sealant self-host installer — bring up the whole product with one command:
#
#   curl -fsSL https://get.sealant.dev | sh
#
# (get.sealant.dev redirects to this script's release asset; the raw GitHub URL works too.)
#
# It checks Docker, downloads the versioned compose file for the latest release, generates secrets,
# pulls the prebuilt images, and starts the stack (web app, API, build worker, SSH gateway, Postgres,
# RabbitMQ, registry). The only host requirements are a running Docker daemon and curl — no git, no
# node, no firewall changes. Everything binds to loopback by default.
#
#   SEALANT_VERSION=0.2.0 …| sh   install/switch to an exact release
#   SEALANT_VERSION=latest …| sh  upgrade an existing install to the newest release
#   (re-running with no version keeps the installed version — a safe repair/reconcile)
#
# Uninstall: docker compose --project-directory ~/.sealant down -v && rm -rf ~/.sealant
set -eu

REPO="sealant-sh/sealant"
INSTALL_DIR="${SEALANT_INSTALL_DIR:-$HOME/.sealant}"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/compose.yaml"

info() { printf '\033[1;36m›\033[0m %s\n' "$1"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
err() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; }
die() {
  err "$1"
  exit 1
}

compose() {
  docker compose --project-directory "$INSTALL_DIR" -f "$COMPOSE_FILE" "$@"
}

# 64 hex chars from the kernel CSPRNG — no openssl/ssh-keygen needed on the host.
generate_secret() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Append KEY=value to .env only when KEY is absent; existing secrets are never regenerated, so
# re-running the installer is always safe (sessions, DB volumes, and SSH host trust survive).
ensure_env_var() {
  if ! grep -q "^$1=" "$ENV_FILE" 2>/dev/null; then
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

# Set KEY=value, replacing an existing line. Drop-then-append (instead of sed substitution) so the
# value is written literally — no metacharacter escaping to get wrong.
set_env_var() {
  if grep -q "^$1=" "$ENV_FILE" 2>/dev/null; then
    tmp="$ENV_FILE.tmp.$$"
    grep -v "^$1=" "$ENV_FILE" >"$tmp" || true
    mv "$tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
}

installed_version() {
  sed -n 's/^SEALANT_VERSION=//p' "$ENV_FILE" 2>/dev/null | head -n 1
}

# Resolve a tunable (ports, bind host): an explicit env var wins and is persisted to .env; else a
# value pinned by a previous run is reused; else the default is persisted. Keeps re-runs and manual
# `docker compose` invocations on the same ports the install chose.
setting() {
  key="$1"
  default="$2"
  explicit="$3"
  if [ -n "$explicit" ]; then
    set_env_var "$key" "$explicit"
    printf '%s' "$explicit"
    return
  fi
  existing="$(sed -n "s/^$key=//p" "$ENV_FILE" 2>/dev/null | head -n 1)"
  if [ -n "$existing" ]; then
    printf '%s' "$existing"
  else
    set_env_var "$key" "$default"
    printf '%s' "$default"
  fi
}

resolve_latest_version() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' |
    head -n 1
}

printf '\n  \033[1mSealant\033[0m self-host installer\n\n'

# --- Preflight ---------------------------------------------------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl is required."
if ! command -v docker >/dev/null 2>&1; then
  die "Docker is not installed. Install it first: https://docs.docker.com/get-docker/"
fi
if ! docker info >/dev/null 2>&1; then
  die "The Docker daemon isn't running (or this user lacks permission). Start Docker and retry."
fi
if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 is required (it ships with Docker Desktop / the docker-compose-plugin)."
fi
# Inline `configs:` in the compose file needs >= 2.23.1. Skip the gate where sort -V is missing
# (rare) — compose itself will then fail with its own message if it's truly too old.
compose_min="2.23.1"
compose_version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
if sort -V </dev/null >/dev/null 2>&1; then
  if [ "$(printf '%s\n%s\n' "$compose_min" "$compose_version" | sort -V | head -n 1)" != "$compose_min" ]; then
    die "Docker Compose >= $compose_min is required (found ${compose_version:-unknown}). Update Docker and retry."
  fi
fi
ok "Docker is ready"

# --- Resolve the version to install -------------------------------------------------------------------
# Precedence: explicit SEALANT_VERSION > version pinned by a previous install > latest release.
# SEALANT_VERSION=latest forces re-resolving (the upgrade path).
requested="${SEALANT_VERSION:-}"
requested="${requested#v}"
if [ -n "$requested" ] && [ "$requested" != "latest" ]; then
  VERSION="$requested"
elif [ "$requested" != "latest" ] && [ -n "$(installed_version)" ]; then
  VERSION="$(installed_version)"
  info "Keeping installed version $VERSION (set SEALANT_VERSION=latest to upgrade)"
else
  info "Resolving the latest release…"
  VERSION="$(resolve_latest_version)"
  [ -n "$VERSION" ] || die "Could not resolve the latest release of $REPO from the GitHub API."
fi
ok "Installing Sealant $VERSION"

# --- Fetch the compose file ---------------------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
if [ -n "${SEALANT_COMPOSE_URL:-}" ]; then
  # Test/dev override: a URL or a local file path.
  if [ -f "$SEALANT_COMPOSE_URL" ]; then
    cp "$SEALANT_COMPOSE_URL" "$COMPOSE_FILE"
  else
    curl -fsSL "$SEALANT_COMPOSE_URL" -o "$COMPOSE_FILE" || die "Failed to download $SEALANT_COMPOSE_URL"
  fi
else
  asset_url="https://github.com/$REPO/releases/download/v$VERSION/compose.selfhost.yaml"
  raw_url="https://raw.githubusercontent.com/$REPO/v$VERSION/compose.selfhost.yaml"
  curl -fsSL "$asset_url" -o "$COMPOSE_FILE" 2>/dev/null ||
    curl -fsSL "$raw_url" -o "$COMPOSE_FILE" ||
    die "Failed to download the compose file for v$VERSION."
fi
ok "Compose file ready in $INSTALL_DIR"

# --- Secrets (generated once, never overwritten) -------------------------------------------------------
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
ensure_env_var SEALANT_DB_PASSWORD "$(generate_secret)"
ensure_env_var SEALANT_RABBITMQ_PASSWORD "$(generate_secret)"
ensure_env_var SANDBOX_SSH_GATEWAY_TOKEN "$(generate_secret)"
ensure_env_var BETTER_AUTH_SECRET "$(generate_secret)"
set_env_var SEALANT_VERSION "$VERSION"
API_PORT="$(setting SEALANT_API_PORT 4000 "${SEALANT_API_PORT:-}")"
WEB_PORT="$(setting SEALANT_WEB_PORT 3000 "${SEALANT_WEB_PORT:-}")"
SSH_PORT="$(setting SEALANT_SSH_PORT 2222 "${SEALANT_SSH_PORT:-}")"
setting SEALANT_REGISTRY_PORT 5000 "${SEALANT_REGISTRY_PORT:-}" >/dev/null
setting SEALANT_BIND_HOST 127.0.0.1 "${SEALANT_BIND_HOST:-}" >/dev/null
ok "Secrets ready ($ENV_FILE)"

# --- Pull images, migrate, start ----------------------------------------------------------------------
info "Pulling images (first run downloads a few hundred MB)…"
# Best-effort: a failed pull is fine when the images are already present (local builds, air-gapped
# re-runs) — the presence check below is what actually gates the install.
compose pull --quiet --ignore-pull-failures 2>/dev/null || true
# Same namespace resolution as the compose file: explicit env > .env from a previous run > the
# default derived from REPO. SEALANT_IMAGE_NS is the fork/mirror escape hatch.
image_ns_pinned="$(sed -n 's/^SEALANT_IMAGE_NS=//p' "$ENV_FILE" 2>/dev/null | head -n 1)"
IMAGE_NS="${SEALANT_IMAGE_NS:-${image_ns_pinned:-ghcr.io/${REPO%/*}}}"
for image_name in sealant-api sealant-worker sealant-ssh-gateway sealant-web; do
  docker image inspect "$IMAGE_NS/$image_name:$VERSION" >/dev/null 2>&1 ||
    die "Image $IMAGE_NS/$image_name:$VERSION is unavailable. Are you offline, or is that release not published (or not public) yet?"
done

info "Applying database migrations…"
compose run --rm migrate >/dev/null || die "Migrations failed. Inspect with: docker compose --project-directory $INSTALL_DIR logs postgres"

info "Starting the platform…"
compose up -d --remove-orphans || die "Failed to start. Inspect with: docker compose --project-directory $INSTALL_DIR logs"
ok "Containers started"

# --- Wait for health -----------------------------------------------------------------------------------
info "Waiting for the API on http://127.0.0.1:${API_PORT} …"
i=0
until curl -fsS "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 90 ] || die "The API did not become healthy. Check: docker compose --project-directory $INSTALL_DIR logs api"
  sleep 2
done
info "Waiting for the web app on http://127.0.0.1:${WEB_PORT} …"
i=0
until curl -fsSL -o /dev/null "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 90 ] || die "The web app did not become healthy. Check: docker compose --project-directory $INSTALL_DIR logs web"
  sleep 2
done

printf '\n'
ok "Sealant $VERSION is running"
printf '\n  Get started:\n'
printf '    1. Open \033[1mhttp://localhost:%s\033[0m and create your account\n' "$WEB_PORT"
printf '    2. Add your SSH public key (Settings → SSH keys, or while creating a sandbox)\n'
printf '    3. Create a sandbox, then connect:  \033[1mssh -p %s sbx-<sandbox-id>@localhost\033[0m\n' "$SSH_PORT"
printf '\n  API for the SDK:  http://localhost:%s\n' "$API_PORT"
printf '\n  Manage it:\n'
printf '    docker compose --project-directory %s logs -f\n' "$INSTALL_DIR"
printf '    docker compose --project-directory %s down\n' "$INSTALL_DIR"
printf '    upgrade:    SEALANT_VERSION=latest curl -fsSL https://get.sealant.dev | sh\n'
printf '    uninstall:  docker compose --project-directory %s down -v && rm -rf %s\n\n' "$INSTALL_DIR" "$INSTALL_DIR"
