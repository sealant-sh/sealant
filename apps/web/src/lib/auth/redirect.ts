const DEFAULT_REDIRECT = "/";

export const resolveRedirectTarget = (redirect: string | undefined): string => {
  if (typeof redirect !== "string" || redirect.length === 0) {
    return DEFAULT_REDIRECT;
  }

  if (redirect.startsWith("/")) {
    return redirect;
  }

  if (typeof window === "undefined") {
    return DEFAULT_REDIRECT;
  }

  try {
    const url = new URL(redirect, window.location.origin);

    if (url.origin !== window.location.origin) {
      return DEFAULT_REDIRECT;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_REDIRECT;
  }
};
