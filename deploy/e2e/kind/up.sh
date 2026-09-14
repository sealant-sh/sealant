#!/usr/bin/env sh
# Bring up the disposable Kubernetes E2E cluster (kind, 3 nodes, generic RWX via NFS CSI,
# cert-manager, registry, RBAC, store Pod) and push a sealantd image into it.
#
#   SEALANTD_IMAGE=<local docker image of sealantd with the WSS frontend> deploy/e2e/kind/up.sh
#
# Idempotent enough to re-run; `deploy/e2e/kind/down.sh` deletes the cluster.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
cluster="${KIND_CLUSTER:-sealant-e2e}"
sealantd_image="${SEALANTD_IMAGE:?set SEALANTD_IMAGE to a local sealantd image (docker build of sealant-sh/sealantd)}"

# Every wait below is gated on an image pulled from a registry nobody here controls: quay.io
# (cert-manager), registry.k8s.io (the NFS provisioner), ghcr.io (zot), docker.io (alpine/git).
# A stall at any of them lands the Pod in ImagePullBackOff, whose retry backs off towards ~5 min,
# so a 180s budget can straddle one backoff window and expire without ever retrying — observed on
# sealant#241, both attempts, where the cert-manager webhook sat at 0/1 for the full 180s and the
# normal rollout is ~13s. Give the pull-gated waits room for a retry; override for a slow link.
wait_timeout="${E2E_WAIT_TIMEOUT:-420s}"

# `kubectl wait` reports only "timed out waiting for the condition" — no object, no reason. Name
# the step we are in and dump the cluster on any non-zero exit, so a failed bring-up always leaves
# something to read instead of one anonymous line.
current_step="starting up"
pf_pid=""

step() {
  current_step="$1"
  echo "==> $current_step"
}

# Callers send the whole function to stderr, so nothing here needs its own redirect.
dump_cluster() {
  echo "==> FAILED while: $current_step"
  echo "--- nodes"
  kubectl get nodes -o wide 2>&1 || true
  echo "--- pods (all namespaces)"
  kubectl get pods --all-namespaces -o wide 2>&1 || true
  echo "--- pods that are not Running/Completed, described"
  kubectl get pods --all-namespaces --no-headers 2>/dev/null \
    | awk '$4 != "Running" && $4 != "Completed" { print $1, $2 }' \
    | while read -r ns name; do
        kubectl -n "$ns" describe pod "$name" 2>&1 || true
        kubectl -n "$ns" logs "$name" --all-containers --tail=50 2>&1 || true
      done
  echo "--- recent events"
  kubectl get events --all-namespaces --sort-by=.lastTimestamp 2>&1 | tail -80 || true
}

on_exit() {
  status=$?
  if [ -n "$pf_pid" ]; then kill "$pf_pid" 2>/dev/null || true; fi
  if [ "$status" -ne 0 ]; then dump_cluster >&2; fi
  exit "$status"
}
trap on_exit EXIT

step "creating the kind cluster"
if ! kind get clusters 2>/dev/null | grep -qx "$cluster"; then
  kind create cluster --name "$cluster" --config "$here/kind-config.yaml" --wait 120s
fi
kubeconfig="${KUBECONFIG:-$HOME/.kube/config}"
export KUBECONFIG="$kubeconfig"
kubectl config use-context "kind-$cluster" >/dev/null

step "rolling out cert-manager (images from quay.io)"
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.2/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout="$wait_timeout"

# Generic RWX: the userspace nfs-ganesha server + provisioner (no kernel nfsd, no extra charts).
step "rolling out the NFS provisioner (image from registry.k8s.io)"
kubectl apply -f "$here/manifests/storage.yaml"
kubectl -n e2e-storage rollout status deploy/nfs-provisioner --timeout="$wait_timeout"

# Namespace, RBAC (the shipped Role), PKI, registry, store Pod
step "applying the sealant namespace, RBAC, PKI, registry and store"
kubectl apply -f "$here/manifests/cluster.yaml"
sed 's/sealant-workspaces/sealant/g' "$here/../../kubernetes/rbac/sealant-worker.yaml" | kubectl apply -f -
step "waiting for the control-client certificate"
kubectl -n sealant wait --for=condition=Ready certificate/control-client --timeout="$wait_timeout"
step "rolling out the in-cluster registry (image from ghcr.io)"
kubectl -n sealant rollout status deploy/sealant-registry --timeout="$wait_timeout"
step "waiting for the store Pod (image from docker.io)"
kubectl -n sealant wait --for=condition=Ready pod/store --timeout="$wait_timeout"
# Export the client TLS material for the test process.
step "exporting the client TLS material"
out="${E2E_TLS_DIR:-$here/.tls}"
mkdir -p "$out"
for key in tls.crt tls.key ca.crt; do
  kubectl -n sealant get secret control-client-tls -o "jsonpath={.data['$(printf '%s' "$key" | sed 's/\./\\./g')']}" | base64 -d > "$out/$key"
done
chmod 600 "$out/tls.key"

# Node containerd cannot resolve *.svc; mirror the registry name to the Service ClusterIP on
# every node via hosts.d (and make sure config_path is enabled — containerd 2.x plugin name).
step "mirroring the registry name onto every node's containerd"
registry_ip="$(kubectl -n sealant get svc sealant-registry -o jsonpath='{.spec.clusterIP}')"
for node in $(kind get nodes --name "$cluster"); do
  docker exec "$node" sh -ec "
    mkdir -p '/etc/containerd/certs.d/sealant-registry.sealant.svc:5000'
    cat > '/etc/containerd/certs.d/sealant-registry.sealant.svc:5000/hosts.toml' <<HOSTS
server = \"http://$registry_ip:5000\"
[host.\"http://$registry_ip:5000\"]
  capabilities = [\"pull\", \"resolve\"]
  skip_verify = true
HOSTS
    grep -q 'config_path = \"/etc/containerd/certs.d\"' /etc/containerd/config.toml || {
      printf '\n[plugins.\"io.containerd.cri.v1.images\".registry]\n  config_path = \"/etc/containerd/certs.d\"\n' >> /etc/containerd/config.toml
      systemctl restart containerd
    }
  "
done

# The containerd restarts above briefly take the apiserver with them; wait for quiet.
step "waiting for every node to come back after the containerd restarts"
kubectl wait --for=condition=Ready node --all --timeout=180s

# Push sealantd through a loopback port-forward (host Docker allows plain HTTP on 127.0.0.0/8).
step "pushing sealantd into the in-cluster registry"
kubectl -n sealant port-forward svc/sealant-registry 35000:5000 >/dev/null 2>&1 &
pf_pid=$!
ok=0
for _ in $(seq 1 150); do
  if curl -fsS http://127.0.0.1:35000/v2/ >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.4
done
[ "$ok" = 1 ] || { echo "registry port-forward never became ready" >&2; exit 1; }
docker tag "$sealantd_image" 127.0.0.1:35000/sealant/sealantd:e2e
docker push 127.0.0.1:35000/sealant/sealantd:e2e

cat <<MSG
Cluster '$cluster' is ready.
  KUBECONFIG=$kubeconfig
  E2E_TLS_DIR=$out
  SEALANT_SEALANTD_IMAGE=sealant-registry.sealant.svc:5000/sealant/sealantd:e2e
Run:  SEALANT_K8S_E2E=1 E2E_TLS_DIR=$out pnpm --filter @sealant/workspaces test:e2e src/kubernetes
MSG
