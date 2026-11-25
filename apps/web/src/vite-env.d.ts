/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** The Sentry release this bundle was built as (`SENTRY_RELEASE` at build time), or "". */
declare const SEALANT_WEB_RELEASE: string;
