from dataclasses import asdict, dataclass, replace
from enum import Enum
import hashlib
import json
from typing import Literal


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


@dataclass(frozen=True)
class FileIdentity:
    sha256: str
    device: int
    inode: int
    uid: int
    gid: int
    mode: int


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    start_ticks: int
    root_device: int
    root_inode: int
    mount_namespace: int
    user_namespace: int
    pid_namespace: int
    cgroup: str
    executable_device: int = 0
    executable_inode: int = 0


@dataclass(frozen=True)
class ExecutableMapping:
    path: str
    sha256: str
    mapped_device: int
    mapped_inode: int
    observed_device: int
    observed_inode: int
    deleted: bool = False


@dataclass(frozen=True)
class ProtectedManifest:
    format: Literal["sealant-guest-manifest-v1"]
    files: dict[str, FileIdentity]
    inputs: dict[str, str]
    bundle_paths: tuple[str, ...]

    def bytes(self):
        return canonical(asdict(self))

    @classmethod
    def parse(cls, value):
        if value["format"] != "sealant-guest-manifest-v1":
            raise ValueError("manifest format")
        files = {path: FileIdentity(**entry) for path, entry in value["files"].items()}
        if not files or any(not path.startswith("/") for path in files):
            raise ValueError("manifest files")
        if any(len(entry.sha256) != 64 or entry.uid != 0 or entry.mode & 0o022 for entry in files.values()):
            raise ValueError("manifest file policy")
        return cls(value["format"], files, value["inputs"], tuple(value["bundle_paths"]))


@dataclass(frozen=True)
class BootBinding:
    boot_id: str
    instance_id: str
    disk_lineage: str
    manifest_digest: str
    approved_profile: str

    def __post_init__(self):
        if any(not isinstance(value, str) or not value for value in asdict(self).values()):
            raise ValueError("incomplete boot binding")


class Status(str, Enum):
    HELD = "held"
    CHECKING = "checking"
    COMPATIBLE = "compatible"
    INCOMPATIBLE = "incompatible"
    TIMED_OUT = "timed-out"


@dataclass(frozen=True)
class BootState:
    binding: BootBinding
    status: Status
    first_invocation: float
    deadline: float
    stable: int = 0
    observed_profile: str | None = None
    reasons: tuple[str, ...] = ()
    admission: Literal["held"] = "held"

    def record(self):
        return asdict(self)


def initial_state(binding, now, deadline_seconds):
    return BootState(binding, Status.HELD, now, now + deadline_seconds)


def transition(state, now, profile, reasons, minimum_stable):
    if state.status == Status.TIMED_OUT:
        return state
    if now >= state.deadline:
        return replace(state, status=Status.TIMED_OUT, stable=0,
                       reasons=tuple(reasons) or state.reasons or ("compatibility-deadline",))
    if reasons:
        return replace(state, status=Status.INCOMPATIBLE, stable=0,
                       observed_profile=profile, reasons=tuple(reasons))
    stable = state.stable + 1 if state.observed_profile == profile else 1
    return replace(state, status=Status.COMPATIBLE if stable >= minimum_stable else Status.CHECKING,
                   stable=stable, observed_profile=profile, reasons=())


def mapping_failures(expected, mappings, before, after):
    failures = []
    if before != after:
        failures.append("process-identity-changed")
    if not mappings:
        failures.append("executable-mappings-missing")
    for mapping in mappings:
        member = expected.get(mapping.path)
        if member is None:
            failures.append("mapping-not-in-manifest:" + mapping.path)
        elif mapping.deleted:
            failures.append("mapping-deleted:" + mapping.path)
        elif (mapping.sha256, mapping.mapped_device, mapping.mapped_inode) != (
                member.sha256, mapping.observed_device, mapping.observed_inode):
            failures.append("mapping-file-identity-mismatch:" + mapping.path)
    return failures


def approved_profile(policy, approval, manifest_digest):
    expected = {
        "format": "sealant-source-profile-approval-v2",
        "profile": policy["profile"],
        "policy_digest": digest(canonical(policy)),
        "manifest_digest": manifest_digest,
        "semantic_checks": "passed-with-shipped-assets",
    }
    if approval is None or any(approval.get(key) != value for key, value in expected.items()):
        return None
    return policy["profile"]


def receipt_failures(receipt, binding):
    return [] if receipt == asdict(binding) else ["stale-boot-receipt"]
