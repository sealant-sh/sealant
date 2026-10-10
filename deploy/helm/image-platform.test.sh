#!/usr/bin/env bash
# `helm template` checks for workspaces.imagePlatform: the API and the worker get one
# SEALANT_WORKSPACE_IMAGE_PLATFORM, from the value or from the arch workspaces.nodeSelector selects,
# and a value the cluster cannot honour fails the render. Run from the repository root.
set -euo pipefail

chart=deploy/helm/sealant
base=(--set secrets.existingSecret=s --set workspaces.namespace=ws)
render() { helm template t "$chart" "${base[@]}" "$@"; }
# The platform env of the named Deployment's container, or "unset".
platform_of() {
  awk -v name="$1" '
    /^kind: / { kind = $2 }
    kind == "Deployment" && /^  name: / { deployment = $2 }
    deployment ~ ("-" name "$") && /SEALANT_WORKSPACE_IMAGE_PLATFORM/ { match($0, /value: "[^"]*"/); print substr($0, RSTART + 8, RLENGTH - 9); found = 1 }
    END { if (!found) print "unset" }
  '
}
expect() {
  local got
  got=$(platform_of "$2" <<<"$3")
  if [ "$got" != "$1" ]; then
    echo "FAIL: $4: $2 has $got, expected $1" >&2
    exit 1
  fi
}

out=$(render)
expect unset api "$out" "default"
expect unset worker "$out" "default"

out=$(render --set workspaces.imagePlatform=linux/arm64)
expect linux/arm64 api "$out" "pinned"
expect linux/arm64 worker "$out" "pinned"

out=$(render --set-json 'workspaces.nodeSelector={"kubernetes.io/arch":"arm64","sealant.sh/pool":"workspaces"}')
expect linux/arm64 api "$out" "from the node selector"
expect linux/arm64 worker "$out" "from the node selector"

out=$(render --set workspaces.imagePlatform=linux/amd64 --set-json 'workspaces.nodeSelector={"kubernetes.io/arch":"amd64"}')
expect linux/amd64 worker "$out" "pinned and selected alike"

for bad in \
  "--set workspaces.imagePlatform=linux/s390x" \
  "--set workspaces.imagePlatform=linux/amd64 --set-json workspaces.nodeSelector={\"kubernetes.io/arch\":\"arm64\"}" \
  "--set-json workspaces.nodeSelector={\"kubernetes.io/arch\":\"riscv64\"}"; do
  # shellcheck disable=SC2086
  if render $bad >/dev/null 2>&1; then
    echo "FAIL: rendered with $bad" >&2
    exit 1
  fi
done

echo "image platform: ok"
