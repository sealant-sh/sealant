/**
 * Arch Linux on ARM64. Docker Hub's `archlinux` image is x86_64 only: built from it, an Arch
 * workspace on an arm64 Docker host or node runs under emulation (Rosetta on Apple silicon, QEMU
 * elsewhere), and a MicroVM, which is ARM64, cannot boot it at all. The official ARM port, Arch
 * Linux ARM, ships a rootfs tarball instead of an image, signed by its build system key (the
 * fingerprint below, checked against a downloaded tarball on 2026-09-20). Every arm64 Arch image
 * starts from it: Docker, Kubernetes and MicroVM builds share the stages rendered here.
 */

/** The file the Arch Linux ARM build key is copied in from, in the build context. */
export const ARCHLINUXARM_KEY_FILE = "archlinuxarm-builder.asc";

export const ARCHLINUXARM_KEY_FINGERPRINT = "68B3537F39A313B3E574D06777193F152BDBE6A6";

export const ARCHLINUXARM_ROOTFS =
  "http://os.archlinuxarm.org/os/ArchLinuxARM-aarch64-latest.tar.gz";

/**
 * Arch Linux ARM's build system key, written into the build context as {@link ARCHLINUXARM_KEY_FILE}.
 * The build checks it carries the fingerprint above before it verifies anything with it.
 */
export const ARCHLINUXARM_BUILDER_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

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
fx6y8+A0kBiaAmcY01U/upYXeHs=
=AIgD
-----END PGP PUBLIC KEY BLOCK-----
`;

/**
 * The tarball is made for boards. Its kernel, modules, device trees and firmware are 1.3 of its
 * 1.9 GB (measured 2026-10-10) and a container or MicroVM boots none of them, so they go, and so
 * does `mkinitcpio`, which only builds a boot image for them. Its two accounts have the
 * passwords the port documents (`root` and `alarm`): on an image that runs one user per person,
 * anyone could `su` to root with them. The `alarm` user goes and root's password is locked, as
 * Docker Hub's `archlinux` image ships it.
 */
const ARCHLINUXARM_BOARD_PACKAGES = "^(linux-aarch64|linux-firmware(-.+)?|mkinitcpio(-busybox)?)$";

/**
 * The stages an arm64 Arch image starts with, in place of `FROM archlinux:latest`. A first stage
 * on `fetchStageImage` (a Fedora image: it has `dnf`) fetches the tarball and its signature,
 * verifies the signature against the key in the build context, and unpacks it; the image proper
 * starts from that filesystem. `pacman-key --populate archlinuxarm` then trusts the port's
 * package keys.
 */
export const renderArchlinuxArmBase = (fetchStageImage: string): string =>
  [
    `FROM ${fetchStageImage} AS archlinuxarm`,
    "RUN dnf -y install gnupg2 curl tar && dnf clean all",
    `COPY ${ARCHLINUXARM_KEY_FILE} /tmp/${ARCHLINUXARM_KEY_FILE}`,
    `RUN set -eu; gpg --batch --import /tmp/${ARCHLINUXARM_KEY_FILE}; \\`,
    `    gpg --batch --list-keys --with-colons | grep -q '^fpr:.*:${ARCHLINUXARM_KEY_FINGERPRINT}:'; \\`,
    `    curl -fsSL --retry 3 -o /tmp/rootfs.tar.gz ${ARCHLINUXARM_ROOTFS}; \\`,
    `    curl -fsSL --retry 3 -o /tmp/rootfs.tar.gz.sig ${ARCHLINUXARM_ROOTFS}.sig; \\`,
    "    gpg --batch --verify /tmp/rootfs.tar.gz.sig /tmp/rootfs.tar.gz; \\",
    "    mkdir /rootfs && tar -xpf /tmp/rootfs.tar.gz --numeric-owner -C /rootfs && rm /tmp/rootfs.tar.gz*",
    "FROM scratch",
    "COPY --from=archlinuxarm /rootfs /",
    "RUN pacman-key --init && pacman-key --populate archlinuxarm && \\",
    `    pacman -Rns --noconfirm $(pacman -Qq | grep -E '${ARCHLINUXARM_BOARD_PACKAGES}') && \\`,
    "    userdel alarm && rm -rf /home/alarm && usermod -p '*' root",
  ].join("\n");
