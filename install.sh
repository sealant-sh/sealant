#!/bin/sh
# Sealant self-host installer — bring up the whole control plane with one command:
#
#   curl -fsSL https://get.sealant.dev | sh
#
# It checks Docker, fetches the platform source, builds + starts the stack (Postgres, RabbitMQ, the
# registry, the API, and the build worker), waits for health, and prints the base URL. The only host
# requirement is a running Docker daemon (the worker drives it to build images + launch sandboxes).
set -eu

REPO_URL="${SEALANT_REPO_URL:-https://github.com/get-sealant/sealant.git}"
INSTALL_DIR="${SEALANT_INSTALL_DIR:-$HOME/.sealant/sealant}"
API_PORT="${SEALANT_API_PORT:-4000}"
COMPOSE_FILE="compose.selfhost.yaml"

info() { printf '\033[1;36m›\033[0m %s\n' "$1"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
err() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; }
die() {
  err "$1"
  exit 1
}

printf '\n  \033[1mSealant\033[0m self-host installer\n\n'

# --- Preflight: Docker (the worker drives it to build images + launch sandboxes) ---------------------
if ! command -v docker >/dev/null 2>&1; then
  die "Docker is not installed. Install it first: https://docs.docker.com/get-docker/"
fi
if ! docker info >/dev/null 2>&1; then
  die "The Docker daemon isn't running (or this user lacks permission). Start Docker and retry."
fi
if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 is required (it ships with Docker Desktop / the docker-compose-plugin)."
fi
ok "Docker is ready"

# --- Get the platform source (the build context). If run inside a checkout, use it. ------------------
if [ -f "$COMPOSE_FILE" ]; then
  REPO_DIR="$(pwd)"
  info "Using the Sealant checkout in $REPO_DIR"
else
  command -v git >/dev/null 2>&1 ||
    die "git is required to fetch Sealant (or run this from a Sealant checkout)."
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating Sealant in $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only --quiet || die "Failed to update $INSTALL_DIR"
  else
    info "Fetching Sealant into $INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" --quiet ||
      die "Failed to clone $REPO_URL (private repo? set SEALANT_REPO_URL, or run inside a checkout)."
  fi
  REPO_DIR="$INSTALL_DIR"
fi
cd "$REPO_DIR"
ok "Source ready"

# --- Bring up the stack (builds the API + worker images from source on first run) -------------------
info "Starting the platform — this builds the API + worker images on first run, which takes a few minutes…"
SEALANT_API_PORT="$API_PORT" docker compose -f "$COMPOSE_FILE" up -d --build ||
  die "Failed to start the stack. Inspect it with: docker compose -f $COMPOSE_FILE logs"
ok "Containers started"

# --- Wait for the API to report healthy --------------------------------------------------------------
info "Waiting for the API on http://127.0.0.1:${API_PORT} …"
i=0
until curl -fsS "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 150 ]; then
    die "The API did not become healthy in time. Check: docker compose -f $COMPOSE_FILE logs api"
  fi
  sleep 2
done

printf '\n'
ok "Sealant is running at \033[1mhttp://localhost:${API_PORT}\033[0m"
printf '\n  Build on it:\n'
printf '    npm i @sealant/sdk\n'
printf "    new Sealant({ baseUrl: 'http://localhost:%s' })\n\n" "$API_PORT"
printf '  Manage it (from %s):\n' "$REPO_DIR"
printf '    docker compose -f %s logs -f\n' "$COMPOSE_FILE"
printf '    docker compose -f %s down\n\n' "$COMPOSE_FILE"
printf '  Private GitHub repos? Set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY in the api + worker env.\n\n'
