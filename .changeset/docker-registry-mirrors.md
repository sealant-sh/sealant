---
"@sealant/sdk": patch
"@sealant/api-contracts": patch
---

Workspace Docker services can pull Docker Hub images through registry mirrors. A worker with
`SEALANT_DOCKER_REGISTRY_MIRRORS=http://docker-mirror:5000` starts every workspace's Docker daemon,
on the Docker and Kubernetes runtimes, with `--registry-mirror` for each origin, plus
`--insecure-registry` for a plain-http one so BuildKit reaches it too. The daemon falls back to
Docker Hub when a mirror fails. On Docker, `SEALANT_DOCKER_REGISTRY_MIRROR_CONTAINER` names the
container serving the mirrors: it joins each workspace's Docker service network under the mirrors'
host names before the daemon starts, and leaves it before the network is removed. The daemon itself
stays off every shared network. An entry that is not a bare origin, or carries credentials, is
refused at startup.
