#!/usr/bin/env bash
# Build (or update) the Sealant MicroVM workspace image with the AWS CLI.
#
# Run by a human with AWS credentials; never by tests or the control plane. Mirrors the POC's
# 01-build-image.sh: stage the context, upload it to S3, create-or-update the image, wait for
# CREATED/UPDATED. Sizing, hooks and logging live on the IMAGE (RunMicrovm has none of them):
#   - resources.minimumMemoryInMiB: 4096 → 2 vCPU baseline, 16 GiB disk (the POC size; the
#     guest sees the 4x burst ceiling, billing follows the baseline);
#   - hooks on port 8080: run/resume/suspend/terminate at the 60 s cap (the platform's maximum
#     per hook; the agent's flush is bounded below it by SEALANT_MICROVM_FLUSH_TIMEOUT_MS),
#     ready/validate 300 s for the build.
# https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmImage.html
#
# Required env: AWS_REGION, MICROVM_IMAGE_NAME, MICROVM_BUILD_ROLE_ARN, MICROVM_ARTIFACT_BUCKET.
# Optional: SEALANTD_IMAGE (default ghcr.io/sealant-sh/sealantd:0.15.0), MICROVM_MEMORY_MIB
# (4096), MICROVM_LOG_GROUP, MICROVM_BASE_IMAGE_ARN (auto: the managed al2023 image),
# MICROVM_TAGS (JSON object). Pass --update to update an existing image (the whole configuration
# is sent again; the API takes no delta).
set -euo pipefail

: "${AWS_REGION:?set AWS_REGION}"
: "${MICROVM_IMAGE_NAME:?set MICROVM_IMAGE_NAME}"
: "${MICROVM_BUILD_ROLE_ARN:?set MICROVM_BUILD_ROLE_ARN}"
: "${MICROVM_ARTIFACT_BUCKET:?set MICROVM_ARTIFACT_BUCKET}"
SEALANTD_IMAGE="${SEALANTD_IMAGE:-ghcr.io/sealant-sh/sealantd:0.15.0}"
MICROVM_MEMORY_MIB="${MICROVM_MEMORY_MIB:-4096}"
export AWS_REGION AWS_PAGER=""

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BASE_IMAGE_ARN="${MICROVM_BASE_IMAGE_ARN:-$(aws lambda-microvms list-managed-microvm-images \
  --query "items[?contains(imageArn, 'al2023')] | [0].imageArn" --output text)}"
[[ -n "$BASE_IMAGE_ARN" && "$BASE_IMAGE_ARN" != None ]] || { log "no managed al2023 base image found; set MICROVM_BASE_IMAGE_ARN"; exit 1; }

# Stage the context: the daemon binaries come out of the released multi-arch image (ARM64
# variant — MicroVMs are Graviton only) so the managed builder needs no cross-registry pull.
CONTEXT="$(mktemp -d)"; trap 'rm -rf "$CONTEXT"' EXIT
cp "$HERE/Dockerfile" "$HERE/agent.mjs" "$CONTEXT/"
log "staging sealantd, sealantctl and socat from $SEALANTD_IMAGE (linux/arm64)"
docker pull --quiet --platform linux/arm64 "$SEALANTD_IMAGE" >/dev/null
STAGE="$(docker create --platform linux/arm64 "$SEALANTD_IMAGE")"
for bin in sealantd sealantctl socat; do
  docker cp "$STAGE:/usr/local/bin/$bin" "$CONTEXT/$bin" || { log "$SEALANTD_IMAGE ships no /usr/local/bin/$bin"; docker rm -f "$STAGE" >/dev/null; exit 1; }
done
docker rm -f "$STAGE" >/dev/null

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
KEY="images/$MICROVM_IMAGE_NAME-$STAMP.zip"
( cd "$CONTEXT" && zip -qr app.zip Dockerfile agent.mjs sealantd sealantctl socat )
aws s3 cp --only-show-errors "$CONTEXT/app.zip" "s3://$MICROVM_ARTIFACT_BUCKET/$KEY"
log "context uploaded to s3://$MICROVM_ARTIFACT_BUCKET/$KEY"

HOOKS='{"port":8080,
  "microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":300,"validate":"ENABLED","validateTimeoutInSeconds":300},
  "microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":60,"resume":"ENABLED","resumeTimeoutInSeconds":60,
                  "suspend":"ENABLED","suspendTimeoutInSeconds":60,"terminate":"ENABLED","terminateTimeoutInSeconds":60}}'
IMAGE_ARN="arn:aws:lambda:$AWS_REGION:$ACCOUNT:microvm-image:$MICROVM_IMAGE_NAME"
COMMON=(
  --description "Sealant workspace image for Lambda MicroVMs (sealantd from $SEALANTD_IMAGE)"
  --base-image-arn "$BASE_IMAGE_ARN"
  --build-role-arn "$MICROVM_BUILD_ROLE_ARN"
  --code-artifact "{\"uri\":\"s3://$MICROVM_ARTIFACT_BUCKET/$KEY\"}"
  --cpu-configurations '[{"architecture":"ARM_64"}]'
  --resources "[{\"minimumMemoryInMiB\":$MICROVM_MEMORY_MIB}]"
  --hooks "$HOOKS"
)
if [[ -n "${MICROVM_LOG_GROUP:-}" ]]; then
  COMMON+=(--logging "{\"cloudWatch\":{\"logGroup\":\"$MICROVM_LOG_GROUP\"}}")
fi
if [[ "${1:-}" == "--update" ]]; then
  aws lambda-microvms update-microvm-image --image-identifier "$IMAGE_ARN" "${COMMON[@]}" >/dev/null
else
  aws lambda-microvms create-microvm-image --name "$MICROVM_IMAGE_NAME" \
    ${MICROVM_TAGS:+--tags "$MICROVM_TAGS"} "${COMMON[@]}" >/dev/null
fi
log "image $IMAGE_ARN submitted; waiting for the build"

deadline=$(( $(date +%s) + 1800 ))
while :; do
  state="$(aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --query state --output text)"
  case "$state" in
    CREATED|UPDATED) break ;;
    *FAILED*) log "image build failed: $state"; aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" --output json; exit 1 ;;
  esac
  (( $(date +%s) < deadline )) || { log "image build did not finish in 30 min (state $state)"; exit 1; }
  sleep 20
done
aws lambda-microvms get-microvm-image --image-identifier "$IMAGE_ARN" \
  --query '{state:state,version:latestActiveImageVersion,failed:latestFailedImageVersion}' --output table
log "set SEALANT_MICROVM_IMAGE_ARN=$IMAGE_ARN on the worker"
