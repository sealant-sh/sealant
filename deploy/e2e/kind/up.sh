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

if ! kind get clusters 2>/dev/null | grep -qx "$cluster"; then
  kind create cluster --name "$cluster" --config "$here/kind-config.yaml" --wait 120s
fi
kubeconfig="${KUBECONFIG:-$HOME/.kube/config}"
export KUBECONFIG="$kubeconfig"
kubectl config use-context "kind-$cluster" >/dev/null

# cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.2/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=180s

# Generic RWX: the userspace nfs-ganesha server + provisioner (no kernel nfsd, no extra charts).
kubectl apply -f "$here/manifests/storage.yaml"
kubectl -n e2e-storage rollout status deploy/nfs-provisioner --timeout=300s

# Namespace, RBAC (the shipped Role), PKI, registry, store Pod
kubectl apply -f "$here/manifests/cluster.yaml"
sed 's/sealant-workspaces/sealant/g' "$here/../../kubernetes/rbac/sealant-worker.yaml" | kubectl apply -f -
kubectl -n sealant wait --for=condition=Ready certificate/control-client --timeout=180s
kubectl -n sealant rollout status deploy/sealant-registry --timeout=180s
kubectl -n sealant wait --for=condition=Ready pod/store --timeout=300s

# Export the client TLS material for the test process.
out="${E2E_TLS_DIR:-$here/.tls}"
mkdir -p "$out"
for key in tls.crt tls.key ca.crt; do
  kubectl -n sealant get secret control-client-tls -o "jsonpath={.data['$(printf '%s' "$key" | sed 's/\./\\./g')']}" | base64 -d > "$out/$key"
done
chmod 600 "$out/tls.key"

# Node containerd cannot resolve *.svc; mirror the registry name to the Service ClusterIP on
# every node via hosts.d (and make sure config_path is enabled — containerd 2.x plugin name).
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
kubectl wait --for=condition=Ready node --all --timeout=180s

# Push sealantd through a loopback port-forward (host Docker allows plain HTTP on 127.0.0.0/8).
kubectl -n sealant port-forward svc/sealant-registry 35000:5000 >/dev/null 2>&1 &
pf_pid=$!
trap 'kill $pf_pid 2>/dev/null || true' EXIT
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
