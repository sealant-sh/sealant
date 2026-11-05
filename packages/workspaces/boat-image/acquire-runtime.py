#!/usr/bin/env python3
"""Extract the pinned native runtime in one owned Boat guest, then delete that guest."""

import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import time
import urllib.parse
import urllib.request
import uuid


if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
    raise SystemExit("Usage: acquire-runtime.py /absolute/private-empty-directory")
root = Path(sys.argv[1]).resolve()
info = root.stat()
if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
    raise SystemExit("output must be an owned private directory")
if any(root.iterdir()):
    raise SystemExit("output directory must be empty")
pin = json.loads((Path(__file__).parent / "../src/images/boat/runtime-pin.json").read_text())
key = os.environ.pop("BOAT_API_KEY")
state = {"marker": str(uuid.uuid4()), "key": str(uuid.uuid4()), "requestedAt": time.time()}


def persist():
    path = root / "runtime-acquisition-ownership.json"
    with open(str(path) + ".next", "w") as stream:
        os.chmod(stream.name, 0o600)
        json.dump(state, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(str(path) + ".next", path)
    fd = os.open(root, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def api(method, path, body=None, headers=None, deadline=None):
    timeout = 660 if path.endswith("/commands") else 45
    if deadline is not None:
        timeout = min(timeout, deadline - time.monotonic())
    if timeout <= 0:
        raise RuntimeError("cleanup deadline exceeded; see ownership journal")
    request = urllib.request.Request(
        "https://boat.dev/api/v1" + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        result = json.load(response)
    if result.get("ok") is not True:
        raise RuntimeError("Boat API refused " + method + " " + path)
    return result


def allocate(deadline=None):
    if time.time() - state["requestedAt"] >= 23 * 60 * 60:
        raise RuntimeError("allocation idempotency window expired")
    for attempt in range(3):
        try:
            sandbox = api("POST", "/sandboxes", {
                "type": "small", "ttlSeconds": 900, "noEnv": True, "monitoring": False,
                "labels": {"sealant-dev": "boat-stream", "sealant-build": state["marker"]},
            }, {"Idempotency-Key": state["key"]}, deadline)["sandbox"]
            if not re.fullmatch(r"bx_[a-z0-9]{8}", sandbox["id"]):
                raise RuntimeError("invalid sandbox identity")
            return sandbox["id"]
        except (OSError, TimeoutError):
            if attempt == 2:
                raise


def download(name, guest_path):
    url = api("POST", "/sandboxes/" + state["sandbox"] + "/files/download-url", {
        "path": guest_path, "ttlSeconds": 60,
    })["url"]
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not (parsed.hostname or "").endswith(".on.boat.dev"):
        raise RuntimeError("unexpected download origin")
    with urllib.request.urlopen(url, timeout=90) as response:
        data = response.read()
    with open(root / name, "wb") as stream:
        os.chmod(stream.name, 0o600)
        stream.write(data)


def interrupted(_number, _frame):
    raise KeyboardInterrupt()


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
persist()
try:
    state["sandbox"] = allocate()
    persist()
    print(json.dumps({"created": state["sandbox"]}), flush=True)
    for _ in range(90):
        sandbox = api("GET", "/sandboxes/" + state["sandbox"])["sandbox"]
        labels = sandbox.get("labels", {})
        if sandbox["id"] != state["sandbox"] or labels.get("sealant-dev") != "boat-stream" or labels.get("sealant-build") != state["marker"]:
            raise RuntimeError("guest identity mismatch")
        if sandbox["state"] in ("ready", "idle", "running"):
            break
        time.sleep(1)
    else:
        raise RuntimeError("guest readiness timed out")
    command = r'''set -eu
sudo apt-get update -qq >/tmp/sealant-acquire-apt.log 2>&1
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends skopeo umoci >>/tmp/sealant-acquire-apt.log 2>&1
d=$(mktemp -d -t sealant-runtime-acquire.XXXXXX)
skopeo inspect --raw docker://__PINNED_SOURCE__ > "$d/index.json"
sha256sum "$d/index.json"
skopeo copy --preserve-digests --override-os linux --override-arch amd64 docker://__PINNED_SOURCE__ "oci:$d/oci:runtime"
(cd "$d/oci/blobs/sha256"; for blob in *; do echo "$blob  $blob" | sha256sum -c - >/dev/null; done)
umoci unpack --rootless --image "$d/oci:runtime" "$d/unpacked"
sha256sum "$d/unpacked/rootfs/usr/local/bin/sealantd" "$d/unpacked/rootfs/usr/local/bin/socat"
"$d/unpacked/rootfs/usr/local/bin/sealantd" capabilities --json
mkdir -p /home/user/sealant-native-acquired
cp "$d/index.json" /home/user/sealant-native-acquired/source-index.json
cp "$d/oci/index.json" /home/user/sealant-native-acquired/layout-index.json
cp -r "$d/oci/blobs" /home/user/sealant-native-acquired/blobs
cp "$d/unpacked/rootfs/usr/local/bin/sealantd" /home/user/sealant-native-acquired/sealantd
cp "$d/unpacked/rootfs/usr/local/bin/socat" /home/user/sealant-native-acquired/socat
python3 -c 'import json,pathlib; p=pathlib.Path("/home/user/sealant-native-acquired"); i=json.loads((p/"layout-index.json").read_text()); d=i["manifests"][0]["digest"].split(":")[1]; print("MANIFEST="+d); print((p/"blobs"/"sha256"/d).read_text())'

'''
    command = command.replace(
        "__PINNED_SOURCE__",
        pin["source"],
    )
    result = api("POST", "/sandboxes/" + state["sandbox"] + "/commands", {
        "command": command, "timeoutSeconds": 600,
    })
    (root / "runtime-acquisition-result.json").write_text(json.dumps(result, indent=2) + "\n")
    if result["exitCode"] != 0 or result.get("timedOut", False):
        raise RuntimeError("guest extraction failed; see runtime-acquisition-result.json")
    guest_root = "/home/user/sealant-native-acquired/"
    for name in ("sealantd", "socat", "source-index.json", "layout-index.json"):
        download(name, guest_root + name)
    layout = json.loads((root / "layout-index.json").read_text())
    manifests = layout["manifests"]
    if len(manifests) != 1 or manifests[0]["digest"] != "sha256:" + pin["manifest"]:
        raise RuntimeError("selected manifest does not match the pin")
    download("platform-manifest.json", guest_root + "blobs/sha256/" + pin["manifest"])
    for name, expected in (
        ("source-index.json", pin["index"]), ("platform-manifest.json", pin["manifest"]),
        ("sealantd", pin["sealantd"]), ("socat", pin["socat"]),
    ):
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
            raise RuntimeError("runtime provenance mismatch in " + name)
    state["verified"] = pin
    persist()
    print(json.dumps({"bundleDownloaded": True, **pin}), flush=True)
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    deadline = time.monotonic() + 180
    if "sandbox" not in state:
        state["sandbox"] = allocate(deadline)
        persist()
    sandbox_id = state["sandbox"]
    sandbox = api("GET", "/sandboxes/" + sandbox_id, deadline=deadline)["sandbox"]
    labels = sandbox.get("labels", {})
    if sandbox["id"] != sandbox_id or labels.get("sealant-dev") != "boat-stream" or labels.get("sealant-build") != state["marker"]:
        raise RuntimeError("cleanup refused sandbox identity mismatch")
    deletion = api("DELETE", "/sandboxes/" + sandbox_id, headers={
        "X-Ascii-Confirm-Delete": sandbox_id,
    }, deadline=deadline)["operation"]
    if deletion["targetId"] != sandbox_id or deletion["kind"] != "sandbox":
        raise RuntimeError("cleanup refused deletion identity mismatch")
    state["deletion"] = deletion
    persist()
    while time.monotonic() < deadline:
        observed = api("GET", "/deletion-operations/" + deletion["id"], deadline=deadline)["operation"]
        if observed["id"] != deletion["id"] or observed["targetId"] != sandbox_id or observed["kind"] != "sandbox":
            raise RuntimeError("cleanup refused deletion identity mismatch")
        if observed["status"] == "completed":
            state["deletion"] = observed
            persist()
            print(json.dumps({"deleted": sandbox_id, "operation": observed["id"]}), flush=True)
            break
        if observed["status"] == "blocked":
            raise RuntimeError("cleanup blocked; see ownership journal")
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    else:
        raise RuntimeError("cleanup pending; see ownership journal")
