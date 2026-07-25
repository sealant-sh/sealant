import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  closeSession,
  createSession,
  getSession,
  getSessionOutput,
  listSessions,
  resizeSession,
  sendSessionInput,
  signalSession,
} from "./sessions.module.js";

export const SessionsHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "sessions",
  (handlers) => {
    return handlers
      .handle("createSession", ({ payload, headers }) => createSession({ payload, headers }))
      .handle("listSessions", ({ query, headers }) => listSessions({ query, headers }))
      .handle("getSession", ({ params, query, headers }) =>
        getSession({ sessionId: params.sessionId, headers, ownerUserId: query.ownerUserId }),
      )
      .handle("getSessionOutput", ({ params, query, headers }) =>
        getSessionOutput({ sessionId: params.sessionId, headers, query }),
      )
      .handle("sendSessionInput", ({ params, payload, headers }) =>
        sendSessionInput({ sessionId: params.sessionId, headers, payload }),
      )
      .handle("resizeSession", ({ params, payload, headers }) =>
        resizeSession({ sessionId: params.sessionId, headers, payload }),
      )
      .handle("signalSession", ({ params, payload, headers }) =>
        signalSession({ sessionId: params.sessionId, headers, payload }),
      )
      .handle("closeSession", ({ params, payload, headers }) =>
        closeSession({ sessionId: params.sessionId, headers, payload }),
      );
  },
);
