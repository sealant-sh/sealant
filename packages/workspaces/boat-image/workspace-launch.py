#!/usr/bin/python3
"""Start only an explicitly admitted session, inside the unit's private namespaces."""
import json
import os
import stat
import subprocess


def private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise ValueError("unsafe launch file")
        return json.load(stream)


if os.getpid() != 1:
    raise SystemExit("native daemon requires PID1")

boot = private_json("/etc/sealant/native-boot.json")
launch = private_json("/run/sealant/launch.json")
if launch.get("admission") != "open":
    raise SystemExit("session admission held")
dynamic = launch.get("env")
if not isinstance(dynamic, dict) or not all(
    isinstance(k, str) and isinstance(v, str) and "\0" not in k + v and "=" not in k
    for k, v in dynamic.items()
):
    raise SystemExit("invalid session environment")
if any(k in dynamic for k in ("SEALANT_SWEEP_EXEMPT_FILE", "LD_PRELOAD", "LD_LIBRARY_PATH")):
    raise SystemExit("unsafe session environment")
env = {**boot, **dynamic}
env.pop("SEALANT_SWEEP_EXEMPT_FILE", None)
env["HOME"] = "/root"
if boot["SEALANT_OS_FAMILY"] == "nix":
    subprocess.run(
        ["/bin/sh", "/usr/local/lib/sealant/native-nix-start"], env=env, check=True
    )
    subprocess.run(
        ["nix", "--extra-experimental-features", "nix-command", "store", "info"],
        env={**env, "NIX_REMOTE": "daemon"}, check=True,
    )
os.execve("/usr/local/bin/sealantd", ["/usr/local/bin/sealantd", "boot"], env)
