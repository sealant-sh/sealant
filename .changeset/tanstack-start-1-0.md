---
"@sealant/sdk": patch
---

The web dashboard and the docs site run on TanStack Start 1.0 (`@tanstack/react-start` 1.169.3) and
TanStack Router 1.170.45, built with Vite 8. That moves `@tanstack/start-server-core` to 1.169.44,
past GHSA-qx66-fv34-fjm8, and the router's seroval to 1.6.9, past GHSA-p6vx-979v-rg4c and
GHSA-jp82-f5mq-hwhp.
