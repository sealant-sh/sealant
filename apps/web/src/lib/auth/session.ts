import type { MaybeAuthSession } from "@sealant/auth/session";
import { createServerFn } from "@tanstack/react-start";

export const getSessionServerFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<MaybeAuthSession> => {
    const [{ getRequest }, { getSealantAuth }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@sealant/auth/server"),
    ]);

    const request = getRequest();
    const auth = await getSealantAuth();

    return auth.api.getSession({
      headers: request.headers,
    });
  },
);
