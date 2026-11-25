/**
 * The browser entry: TanStack Start's default one, plus React's `onCaughtError` and
 * `onRecoverableError`, so an error an error boundary catches (TanStack's route boundaries
 * included), or one React recovers from, is reported to Sentry once when telemetry is on. Both
 * still log the error, as React's defaults do.
 */
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

import { reportCaughtError, reportRecoverableError } from "@/lib/telemetry/browser";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
    {
      onCaughtError: (error, errorInfo) => {
        console.error(error);
        reportCaughtError(error, errorInfo);
      },
      // React's default reports these as uncaught window errors, so the same failure would reach
      // Sentry twice: once from its error boundary and once from here.
      onRecoverableError: (error, errorInfo) => {
        console.error(error);
        reportRecoverableError(error, errorInfo);
      },
    },
  );
});
