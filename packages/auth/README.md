# Auth Package

`@sealant/auth` is the shared Better Auth package for Sealant product apps.

It currently provides:

- Better Auth server creation backed by the shared `@sealant/db` SQLite database
- a small env parser for Better Auth runtime settings
- a generic client factory for app-side Better Auth usage
- server-side helpers for reading and requiring the current session

## Environment

- `NODE_ENV`: runtime environment; defaults to `development`
- `BETTER_AUTH_APP_NAME`: display name; defaults to `Sealant`
- `BETTER_AUTH_SECRET`: optional Better Auth secret; should be set in real deployments
- `BETTER_AUTH_URL`: optional canonical app URL for Better Auth
- `BETTER_AUTH_TRUSTED_ORIGINS`: optional comma-separated trusted origins list

## Usage

```ts
import { createSealantAuth, createSealantAuthClient } from "@sealant/auth";

const auth = await createSealantAuth();
const authClient = createSealantAuthClient();
```
