#!/usr/bin/env bash
# Build (or update) a Sealant MicroVM workspace image with the AWS CLI.
#
# Run by a human with AWS credentials; never by tests or the control plane. The default path keeps
# the existing non-Docker image contract. MICROVM_DOCKER_ENABLED=true selects Dockerfile.docker,
# requires a different MICROVM_DOCKER_IMAGE_NAME, and is the only path that requests the image-level
# ALL OS capability needed for guest filesystem mounts and network namespaces.
#
# Sizing, hooks and logging live on the image because RunMicrovm has none of them. The default
# 4096 MiB means a 2 vCPU baseline and 16 GiB disk. Runtime hooks use the platform's 60 second cap;
# ready and validate use 300 seconds for the build.
# https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmImage.html
#
# Required env: AWS_REGION, MICROVM_IMAGE_NAME, MICROVM_BUILD_ROLE_ARN, MICROVM_ARTIFACT_BUCKET.
# Docker variant: MICROVM_DOCKER_ENABLED=true and MICROVM_DOCKER_IMAGE_NAME=<different name>.
# Optional: SEALANTD_IMAGE (default ghcr.io/sealant-sh/sealantd:0.15.2), MICROVM_MEMORY_MIB
# (4096), MICROVM_LOG_GROUP, MICROVM_BASE_IMAGE_ARN (auto: the managed al2023 image),
# MICROVM_TAGS (JSON object). Pass --update to update the selected image; the whole configuration
# is sent again because the API takes no delta.
set -euo pipefail

usage() {
  printf 'usage: %s [--update]\n' "${0##*/}" >&2
}

case "${1-}" in
"") ;;
--update) ;;
*)
  usage
  exit 2
  ;;
esac
(($# <= 1)) || {
  usage
  exit 2
}

: "${AWS_REGION:?set AWS_REGION}"
: "${MICROVM_IMAGE_NAME:?set MICROVM_IMAGE_NAME}"
: "${MICROVM_BUILD_ROLE_ARN:?set MICROVM_BUILD_ROLE_ARN}"
: "${MICROVM_ARTIFACT_BUCKET:?set MICROVM_ARTIFACT_BUCKET}"
SEALANTD_IMAGE="${SEALANTD_IMAGE:-ghcr.io/sealant-sh/sealantd:0.15.2}"
MICROVM_MEMORY_MIB="${MICROVM_MEMORY_MIB:-4096}"
MICROVM_DOCKER_ENABLED="${MICROVM_DOCKER_ENABLED-false}"
export AWS_REGION AWS_PAGER=""

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

case "$MICROVM_DOCKER_ENABLED" in
false)
  IMAGE_NAME="$MICROVM_IMAGE_NAME"
  RECIPE="$HERE/Dockerfile"
  IMAGE_KIND="default"
  IMAGE_DESCRIPTION="Sealant workspace image for Lambda MicroVMs (sealantd from $SEALANTD_IMAGE)"
  ;;
true)
  : "${MICROVM_DOCKER_IMAGE_NAME:?set MICROVM_DOCKER_IMAGE_NAME when MICROVM_DOCKER_ENABLED=true}"
  [[ "$MICROVM_DOCKER_IMAGE_NAME" != "$MICROVM_IMAGE_NAME" ]] || {
    log "MICROVM_DOCKER_IMAGE_NAME must differ from MICROVM_IMAGE_NAME"
    exit 2
  }
  IMAGE_NAME="$MICROVM_DOCKER_IMAGE_NAME"
  RECIPE="$HERE/Dockerfile.docker"
  IMAGE_KIND="Docker-capable"
  IMAGE_DESCRIPTION="Sealant Docker-capable workspace image for Lambda MicroVMs (sealantd from $SEALANTD_IMAGE)"
  ;;
*)
  log "MICROVM_DOCKER_ENABLED must be exactly true or false"
  exit 2
  ;;
esac

# Validate every local input before making an AWS call. The current agent imports the service
# module even for v1 launches, so both image variants stage it. Only the Docker variant receives
# the runtime payload and installation script.
LOCAL_INPUTS=("$RECIPE" "$HERE/agent.mjs" "$HERE/docker-service.mjs")
if [[ "$MICROVM_DOCKER_ENABLED" == true ]]; then
  LOCAL_INPUTS+=("$HERE/download-docker.sh")
fi
for input in "${LOCAL_INPUTS[@]}"; do
  [[ -f "$input" ]] || {
    log "required image input is missing: ${input##*/}"
    exit 1
  }
done

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BASE_IMAGE_ARN="${MICROVM_BASE_IMAGE_ARN:-$(aws lambda-microvms list-managed-microvm-images \
  --query "items[?contains(imageArn, 'al2023')] | [0].imageArn" --output text)}"
[[ -n "$BASE_IMAGE_ARN" && "$BASE_IMAGE_ARN" != None ]] || {
  log "no managed al2023 base image found; set MICROVM_BASE_IMAGE_ARN"
  exit 1
}

# Stage the context. sealantd binaries come from the ARM64 variant of the released image so the
# managed builder needs no cross-registry pull. The trap removes a partially created container and
# context on every exit path, including a missing staged binary.
CONTEXT=""
STAGE=""
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$STAGE" ]]; then
    docker rm -f "$STAGE" >/dev/null 2>&1 || true
  fi
  if [[ -n "$CONTEXT" ]]; then
    rm -rf "$CONTEXT"
  fi
  exit "$status"
}
trap cleanup EXIT

CONTEXT="$(mktemp -d)"
cp "$RECIPE" "$CONTEXT/Dockerfile"
cp "$HERE/agent.mjs" "$HERE/docker-service.mjs" "$CONTEXT/"
ZIP_FILES=(Dockerfile agent.mjs docker-service.mjs sealantd sealantctl socat)
if [[ "$MICROVM_DOCKER_ENABLED" == true ]]; then
  cp "$HERE/download-docker.sh" "$CONTEXT/"
  ZIP_FILES+=(download-docker.sh)
fi

log "staging sealantd, sealantctl and socat from $SEALANTD_IMAGE (linux/arm64)"
docker pull --quiet --platform linux/arm64 "$SEALANTD_IMAGE" >/dev/null
STAGE="$(docker create --platform linux/arm64 "$SEALANTD_IMAGE")"
for bin in sealantd sealantctl socat; do
  if ! docker cp "$STAGE:/usr/local/bin/$bin" "$CONTEXT/$bin"; then
    log "$SEALANTD_IMAGE ships no /usr/local/bin/$bin"
    exit 1
  fi
done
docker rm -f "$STAGE" >/dev/null
STAGE=""

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
KEY="images/$IMAGE_NAME-$STAMP.zip"
(cd "$CONTEXT" && zip -qr app.zip "${ZIP_FILES[@]}")
aws s3 cp --only-show-errors "$CONTEXT/app.zip" "s3://$MICROVM_ARTIFACT_BUCKET/$KEY"
log "$IMAGE_KIND context uploaded to s3://$MICROVM_ARTIFACT_BUCKET/$KEY"

HOOKS='{"port":8080,
  "microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":300,"validate":"ENABLED","validateTimeoutInSeconds":300},
  "microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":60,"resume":"ENABLED","resumeTimeoutInSeconds":60,
                  "suspend":"ENABLED","suspendTimeoutInSeconds":60,"terminate":"ENABLED","terminateTimeoutInSeconds":60}}'
IMAGE_ARN="arn:aws:lambda:$AWS_REGION:$ACCOUNT:microvm-image:$IMAGE_NAME"
COMMON=(
  --description "$IMAGE_DESCRIPTION"
  --base-image-arn "$BASE_IMAGE_ARN"
  --build-role-arn "$MICROVM_BUILD_ROLE_ARN"
  --code-artifact "{\"uri\":\"s3://$MICROVM_ARTIFACT_BUCKET/$KEY\"}"
  --cpu-configurations '[{"architecture":"ARM_64"}]'
  --resources "[{\"minimumMemoryInMiB\":$MICROVM_MEMORY_MIB}]"
  --hooks "$HOOKS"
)
if [[ "$MICROVM_DOCKER_ENABLED" == true ]]; then
  COMMON+=(--additional-os-capabilities '["ALL"]')
fi
if [[ -n "${MICROVM_LOG_GROUP:-}" ]]; then
  COMMON+=(--logging "{\"cloudWatch\":{\"logGroup\":\"$MICROVM_LOG_GROUP\"}}")
fi
if [[ "${1:-}" == "--update" ]]; then
  aws lambda-microvms update-microvm-image --image-identifier "$IMAGE_ARN" "${COMMON[@]}" >/dev/null
else
  aws lambda-microvms create-microvm-image --name "$IMAGE_NAME" \
    ${MICROVM_TAGS:+--tags "$MICROVM_TAGS"} "${COMMON[@]}" >/dev/null
fi
log "image $IMAGE_ARN submitted; waiting for the build"

deadline=$(($(date +%s) + 1800))
while :; do
  state="$(aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --query state --output text)"
  case "$state" in
  CREATED | UPDATED) break ;;
  *FAILED*)
    log "image build failed in state $state"
    exit 1
    ;;
  esac
  (($(date +%s) < deadline)) || {
    log "image build did not finish in 30 min (state $state)"
    exit 1
  }
  sleep 20
done
aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" \
  --query '{state:state,version:latestActiveImageVersion,failed:latestFailedImageVersion}' --output table
if [[ "$MICROVM_DOCKER_ENABLED" == true ]]; then
  log "set SEALANT_MICROVM_DOCKER_IMAGE_ARN=$IMAGE_ARN and the same pinned SEALANT_MICROVM_DOCKER_IMAGE_VERSION on both API and worker"
else
  log "set SEALANT_MICROVM_IMAGE_ARN=$IMAGE_ARN on the worker"
fi
