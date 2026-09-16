#!/usr/bin/env bash
# Focused packaging tests. All AWS and Docker commands are fakes; this script makes no cloud call
# and never starts a container or daemon.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'if [[ "${KEEP_TEST_ROOT:-false}" == true ]]; then printf "kept test root: %s\\n" "$TEST_ROOT" >&2; else rm -rf "$TEST_ROOT"; fi' EXIT
PASS=0

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1" text="$2"
  grep -F -- "$text" "$file" >/dev/null || fail "$file does not contain: $text"
}

assert_not_contains() {
  local file="$1" text="$2"
  if grep -F -- "$text" "$file" >/dev/null; then
    fail "$file unexpectedly contains: $text"
  fi
}

assert_empty_dir() {
  local directory="$1"
  [[ -z "$(find "$directory" -mindepth 1 -print -quit)" ]] || fail "$directory was not cleaned"
}

make_case() {
  local name="$1"
  CASE_DIR="$TEST_ROOT/$name"
  FIXTURE="$CASE_DIR/fixture"
  RECORDS="$CASE_DIR/records"
  FAKE_BIN="$CASE_DIR/bin"
  mkdir -p "$FIXTURE" "$RECORDS" "$FAKE_BIN" "$CASE_DIR/tmp"
  cp "$HERE/build-image.sh" "$HERE/Dockerfile" "$HERE/Dockerfile.docker" \
    "$HERE/download-docker.sh" "$FIXTURE/"
  printf 'console.log("fixture agent");\n' >"$FIXTURE/agent.mjs"
  printf 'export const fixture = true;\n' >"$FIXTURE/docker-service.mjs"

  cat >"$FAKE_BIN/aws" <<'FAKE_AWS'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"$FAKE_RECORDS/aws.calls"
printf '\n' >>"$FAKE_RECORDS/aws.calls"
case "$1 $2" in
  "sts get-caller-identity") printf '123456789012\n' ;;
  "lambda-microvms list-managed-microvm-images")
    printf 'arn:aws:lambda:%s:aws:microvm-image:al2023\n' "$AWS_REGION"
    ;;
  "s3 cp")
    for argument in "$@"; do
      if [[ "$argument" == *.zip && -f "$argument" ]]; then
        cp "$argument" "$FAKE_RECORDS/upload.zip"
      fi
    done
    ;;
  "lambda-microvms create-microvm-image"|"lambda-microvms update-microvm-image") ;;
  "lambda-microvms get-microvm-image")
    if [[ " $* " == *" --query state "* ]]; then printf 'CREATED\n'; else printf 'CREATED 1 -\n'; fi
    ;;
  *) printf 'unexpected fake aws call: %s\n' "$*" >&2; exit 90 ;;
esac
FAKE_AWS

  cat >"$FAKE_BIN/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"$FAKE_RECORDS/docker.calls"
printf '\n' >>"$FAKE_RECORDS/docker.calls"
case "$1" in
  pull) ;;
  create) printf 'fake-stage\n' ;;
  cp)
    binary="${2##*/}"
    if [[ "$binary" == "${FAKE_DOCKER_FAIL_BIN:-}" ]]; then exit 41; fi
    printf 'fixture %s\n' "$binary" >"$3"
    chmod 0755 "$3"
    ;;
  rm) ;;
  *) printf 'unexpected fake docker call: %s\n' "$*" >&2; exit 91 ;;
esac
FAKE_DOCKER
  chmod +x "$FAKE_BIN/aws" "$FAKE_BIN/docker" "$FIXTURE/build-image.sh"
}

run_build_with_arg() {
  local script_arg="$1"
  shift
  local script_args=()
  [[ -z "$script_arg" ]] || script_args+=("$script_arg")
  env \
    PATH="$FAKE_BIN:$PATH" \
    TMPDIR="$CASE_DIR/tmp" \
    FAKE_RECORDS="$RECORDS" \
    AWS_REGION="eu-central-1" \
    MICROVM_IMAGE_NAME="sealant-workspace" \
    MICROVM_BUILD_ROLE_ARN="arn:aws:iam::123456789012:role/microvm-build" \
    MICROVM_ARTIFACT_BUCKET="sealant-artifacts" \
    MICROVM_BASE_IMAGE_ARN="arn:aws:lambda:eu-central-1:aws:microvm-image:al2023" \
    "$@" \
    "$FIXTURE/build-image.sh" "${script_args[@]}"
}

run_build() {
  run_build_with_arg "" "$@"
}

run_update() {
  run_build_with_arg --update "$@"
}

pass() {
  PASS=$((PASS + 1))
  printf 'ok %d - %s\n' "$PASS" "$1"
}

make_case default
run_build >"$RECORDS/stdout" 2>"$RECORDS/stderr"
assert_contains "$RECORDS/aws.calls" "create-microvm-image --name sealant-workspace"
assert_not_contains "$RECORDS/aws.calls" "additional-os-capabilities"
unzip -Z1 "$RECORDS/upload.zip" >"$RECORDS/archive.list"
for file in Dockerfile agent.mjs docker-service.mjs sealantd sealantctl socat; do
  assert_contains "$RECORDS/archive.list" "$file"
done
assert_not_contains "$RECORDS/archive.list" "download-docker.sh"
unzip -p "$RECORDS/upload.zip" Dockerfile >"$RECORDS/staged.Dockerfile"
cmp -s "$HERE/Dockerfile" "$RECORDS/staged.Dockerfile" || fail "default build changed Dockerfile"
assert_not_contains "$RECORDS/staged.Dockerfile" "SEALANT_MICROVM_DOCKER_CAPABLE"
pass "default image stays non-Docker and does not request ALL"

make_case docker
run_build MICROVM_DOCKER_ENABLED=true MICROVM_DOCKER_IMAGE_NAME=sealant-workspace-docker \
  >"$RECORDS/stdout" 2>"$RECORDS/stderr"
assert_contains "$RECORDS/aws.calls" "create-microvm-image --name sealant-workspace-docker"
assert_contains "$RECORDS/aws.calls" '--additional-os-capabilities \[\"ALL\"\]'
assert_not_contains "$RECORDS/aws.calls" "create-microvm-image --name sealant-workspace "
unzip -Z1 "$RECORDS/upload.zip" >"$RECORDS/archive.list"
assert_contains "$RECORDS/archive.list" "docker-service.mjs"
assert_contains "$RECORDS/archive.list" "download-docker.sh"
unzip -p "$RECORDS/upload.zip" Dockerfile >"$RECORDS/staged.Dockerfile"
assert_contains "$RECORDS/staged.Dockerfile" "SEALANT_MICROVM_DOCKER_CAPABLE=1"
assert_contains "$RECORDS/staged.Dockerfile" "iproute iptables-nft kmod"
assert_contains "$RECORDS/staged.Dockerfile" "/run/docker /var/lib/sealant/docker"
pass "Docker variant uses a separate image, ALL, capability marker and runtime payload"

make_case docker-update
run_update MICROVM_DOCKER_ENABLED=true MICROVM_DOCKER_IMAGE_NAME=sealant-workspace-docker \
  >"$RECORDS/stdout" 2>"$RECORDS/stderr"
assert_contains "$RECORDS/aws.calls" \
  "update-microvm-image --image-identifier arn:aws:lambda:eu-central-1:123456789012:microvm-image:sealant-workspace-docker"
assert_contains "$RECORDS/aws.calls" '--additional-os-capabilities \[\"ALL\"\]'
assert_not_contains "$RECORDS/aws.calls" "create-microvm-image"
pass "Docker image updates retain the separate name and ALL capability"

make_case invalid-option
if run_build MICROVM_DOCKER_ENABLED=1 >"$RECORDS/stdout" 2>"$RECORDS/stderr"; then
  fail "invalid Docker option succeeded"
fi
assert_contains "$RECORDS/stderr" "must be exactly true or false"
[[ ! -e "$RECORDS/aws.calls" ]] || fail "invalid option reached AWS"
[[ ! -e "$RECORDS/docker.calls" ]] || fail "invalid option reached Docker"
pass "invalid Docker option fails before external commands"

make_case missing-name
if run_build MICROVM_DOCKER_ENABLED=true >"$RECORDS/stdout" 2>"$RECORDS/stderr"; then
  fail "Docker build without an explicit image name succeeded"
fi
assert_contains "$RECORDS/stderr" "set MICROVM_DOCKER_IMAGE_NAME"
[[ ! -e "$RECORDS/aws.calls" ]] || fail "missing Docker image name reached AWS"
pass "Docker variant requires an explicit image name"

make_case reused-name
if run_build MICROVM_DOCKER_ENABLED=true MICROVM_DOCKER_IMAGE_NAME=sealant-workspace \
  >"$RECORDS/stdout" 2>"$RECORDS/stderr"; then
  fail "Docker build reused the default image name"
fi
assert_contains "$RECORDS/stderr" "must differ from MICROVM_IMAGE_NAME"
[[ ! -e "$RECORDS/aws.calls" ]] || fail "reused image name reached AWS"
pass "Docker variant cannot reuse the default image name"

make_case missing-service
rm "$FIXTURE/docker-service.mjs"
if run_build >"$RECORDS/stdout" 2>"$RECORDS/stderr"; then
  fail "build without docker-service.mjs succeeded"
fi
assert_contains "$RECORDS/stderr" "required image input is missing: docker-service.mjs"
[[ ! -e "$RECORDS/aws.calls" ]] || fail "missing service module reached AWS"
pass "missing guest service module fails before external commands"

make_case failed-stage
if run_build FAKE_DOCKER_FAIL_BIN=sealantctl >"$RECORDS/stdout" 2>"$RECORDS/stderr"; then
  fail "build with a missing staged binary succeeded"
fi
assert_contains "$RECORDS/stderr" "ships no /usr/local/bin/sealantctl"
assert_contains "$RECORDS/docker.calls" "rm -f fake-stage"
assert_empty_dir "$CASE_DIR/tmp"
[[ ! -e "$RECORDS/upload.zip" ]] || fail "failed stage produced an upload"
assert_not_contains "$RECORDS/aws.calls" "s3 cp"
pass "failed binary staging removes the container and temporary context"

for expected in \
  'DOCKER_VERSION="29.8.1"' \
  'DOCKER_SHA256="667395fbffab52901b80181dfbb39ea76da2fbd7642c4fbddd24e42146b07b48"' \
  'BUILDX_VERSION="0.37.1"' \
  'BUILDX_SHA256="e5cc9fe3bbff5cbc91230981f7860e06076110730a2db997082652199042a1f2"' \
  'COMPOSE_VERSION="5.5.1"' \
  'COMPOSE_SHA256="732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7"' \
  'docker --version' \
  'dockerd --version' \
  'docker buildx version' \
  'docker compose version'; do
  assert_contains "$HERE/download-docker.sh" "$expected"
done
assert_not_contains "$HERE/download-docker.sh" "latest"
pass "Docker engine, client, buildx and Compose downloads are pinned and version-checked"

printf '1..%d\n' "$PASS"
