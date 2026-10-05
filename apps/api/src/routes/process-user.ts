/**
 * Why a process cannot run as `user` yet (Mend ADR 0016): Core starts it through sealantd, and no
 * released sealantd can start a process as another user. Refused before anything is started,
 * never run as the workspace's own user in its place.
 */
export const processUserUnsupportedMessage = (user: string): string =>
  `This workspace's runtime cannot start a process as the Linux user '${user}' yet: sealantd does not report running a process as another user. Nothing was started.`;
