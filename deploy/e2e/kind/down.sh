#!/usr/bin/env sh
set -eu
kind delete cluster --name "${KIND_CLUSTER:-sealant-e2e}"
