# Sealant Mobile Product Plan

Current date: June 20, 2026.

## Research Summary

Expo architecture:

- Use Expo SDK 56 for the first scaffold. Expo SDK 56 targets React Native 0.85 and React 19.2.3,
  and each Expo SDK targets one React Native version. Source:
  [Expo SDK reference](https://docs.expo.dev/versions/latest/),
  [Expo SDK 56 changelog](https://expo.dev/changelog/sdk-56).
- Use Expo Router for file-based navigation, typed/deep-linkable routes, and route-level lazy
  loading. Sources: [Expo Router intro](https://docs.expo.dev/router/introduction/),
  [Expo Router core concepts](https://docs.expo.dev/router/basics/core-concepts/).
- Use EAS Build profiles for development, preview, and production. Push notification testing should
  use development builds, not Expo Go. Sources:
  [EAS Build](https://docs.expo.dev/build/introduction/),
  [push setup](https://docs.expo.dev/push-notifications/push-notifications-setup/),
  [what to know about notifications](https://docs.expo.dev/push-notifications/what-you-need-to-know/).
- Use `expo-secure-store` for small session secrets only; use AsyncStorage only for non-secret cache
  persistence. Sources: [SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/),
  [AsyncStorage](https://docs.expo.dev/versions/latest/sdk/async-storage/).

React Native architecture:

- Use New Architecture from day one. React Native 0.76 enabled it by default and SDK 55+ cannot
  disable it. Reanimated 4 also requires New Architecture. Sources:
  [React Native New Architecture](https://reactnative.dev/architecture/landing-page),
  [Reanimated compatibility](https://docs.swmansion.com/react-native-reanimated/docs/guides/compatibility/).
- Keep list screens dense and lightweight; use release-build profiling for performance work.
  Sources: [React Native performance](https://reactnative.dev/docs/performance),
  [optimizing JS loading](https://reactnative.dev/docs/optimizing-javascript-loading).
- Use `react-native-gesture-handler` and Reanimated only where gestures/animations materially
  improve operational decisions. Sources:
  [Gesture Handler intro](https://docs.swmansion.com/react-native-gesture-handler/docs/fundamentals/introduction/),
  [Reanimated getting started](https://docs.swmansion.com/react-native-reanimated/docs/fundamentals/getting-started/).

Server state:

- Use TanStack Query v5 with persisted query cache for offline-tolerant reads, not offline mutation
  queues. Source:
  [TanStack React Native](https://tanstack.com/query/v5/docs/framework/react/react-native),
  [persistQueryClient](https://tanstack.com/query/v5/docs/framework/react/plugins/persistQueryClient).
- If offline writes are added later, require idempotency keys, backend conflict semantics, and
  default mutation functions before resuming persisted mutations. Source:
  [TanStack mutations](https://tanstack.com/query/v5/docs/framework/react/guides/mutations).

Auth:

- Recommended live path is Better Auth's Expo integration with `expo-secure-store` and a
  `sealant://` scheme in trusted origins. Source:
  [Better Auth Expo integration](https://better-auth.com/docs/integrations/expo),
  [Expo AuthSession](https://docs.expo.dev/versions/latest/sdk/auth-session/).
- Current scaffold uses a local demo session only. Do not ship that as production auth. Better Auth
  version compatibility must be handled before enabling the live client/server plugin path.

Operational/security UX:

- Use timeline-native incident-style views, approval details with context before commitment, and
  compressed PR review packets. Sources: [GitHub Mobile](https://github.com/mobile),
  [GitHub mobile PR improvements](https://github.blog/changelog/2021-05-11-working-with-pull-requests-on-github-mobile-is-now-much-easier/),
  [Atlassian incident management](https://www.atlassian.com/incident-management),
  [Atlassian incident tools](https://www.atlassian.com/incident-management/tools).
- Use text plus icon plus color for risk and status, never color alone. Sources:
  [React Native accessibility](https://reactnative.dev/docs/accessibility),
  [WCAG use of color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html),
  [WCAG target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

## Recommended Stack

- Expo SDK 56.
- Expo Router.
- React Native 0.85.3 via Expo SDK compatibility.
- React 19.2 via workspace catalog.
- TanStack Query v5 with AsyncStorage persistence.
- `expo-secure-store` for auth/session secret storage.
- `expo-notifications` for run status notifications.
- `lucide-react-native` plus `react-native-svg` for icons.
- Development builds/EAS from day one.

Risks:

- React Native latest is 0.86, but Expo SDK 56 targets 0.85. Do not mix arbitrary RN packages
  outside Expo compatibility.
- Better Auth Expo docs are newer than the current repo auth package declaration. Coordinate that
  dependency before enabling live mobile auth.
- EAS Update cannot ship native dependency/config changes; those require a new binary.
- Push notifications, Face ID, and production deep-link auth need development or production builds.

## Product Map

Phase 1: Mobile control room for sandboxes

- Sign in.
- Home / Run Command Center.
- Active sandboxes.
- Sandbox detail.
- Sandbox attempts.
- Sandbox events timeline.
- Package/repo-backed sandbox creation shortcut.
- GitHub repository picker placeholder.
- Push notification architecture and preview.

Phase 2: Issue workflow mobile MVP

- Issue inbox.
- Ready-to-run issues.
- Issue detail.
- Start issue workflow.
- Workflow detail.
- Validation and PR readiness.
- Approval requests.

Current implementation keeps this phase preview-backed behind `src/api/mock/*`.

Phase 3: Run Record and review compression

- Run Record overview.
- Commands run count and evidence timeline.
- Files changed grouped by intent.
- Validation results.
- Risk flags.
- Runtime evidence.
- PR review summary.

## API Gap List

Works today:

- `GET /v1/sandboxes`.
- `POST /v1/sandboxes`.
- `GET /v1/sandboxes/:sandboxId`.
- `GET /v1/sandboxes/:sandboxId/attempts`.
- `GET /v1/sandboxes/:sandboxId/events`.
- `GET /v1/sandboxes/:sandboxId/ssh-target`.
- Registry metadata/tag/manifest endpoints.
- Package resolution endpoint.
- GitHub installation and repository sync endpoints.

Must be mocked for MVP:

- Issue workflow list/detail/status/actions.
- Approval request list/detail/decision writes.
- Run Record summaries, risk flags, grouped file intent, commands, artifacts, PR outcome.
- Registry catalog/repository browsing.
- Mobile-authenticated API identity.

Next backend endpoints:

- Authenticated mobile control-plane session support; derive user identity server-side.
- `GET /v1/issue-workflows`.
- `GET /v1/issue-workflows/:id`.
- Execution detail/events/validation/diff/artifact bundle endpoints.
- Start/retry/cancel issue workflow endpoints.
- Approval approve/reject/request-changes endpoints.
- PR lineage and PR creation approval endpoints.
- `GET /v1/registries` and `GET /v1/registries/:registryId/catalog`.
- Sandbox retry/rebuild/cancel/archive endpoints.

## Scaffold Proposal

Implemented structure:

- `src/app/*`: Expo Router routes.
- `src/api/live/*`: mobile-safe live control-plane adapters.
- `src/api/mock/*`: preview data adapters for planned issue workflow and Run Record surfaces.
- `src/api/types/*`: React Native-safe product types.
- `src/components/*`: dense operational UI primitives and rows.
- `src/features/run-record/*`: reviewer-focused Run Record packet.
- `src/providers/query-provider.tsx`: TanStack Query persistence.
- `src/lib/session-store.ts`: SecureStore-backed demo session storage.
- `src/lib/notifications.ts`: push registration and preview notification architecture.

## Run Record Design Notes

The Run Record screen should answer, in under 60 seconds:

- What was the objective?
- What did the agent actually do?
- What changed and why?
- What commands/tests ran?
- What failed or was skipped?
- What risky areas were touched?
- What needs human attention before merge?

Mobile should not default to a full diff. It should show a review packet first, then offer escape
hatches into full files, artifacts, logs, and GitHub.
