# Initial UI/UX Flow Analysis (apps/web)

Date: 2026-04-01 Author: OpenCode (Playwright pass on localhost:3000)

## Scope

- Evaluated authenticated and unauthenticated UX flows in `apps/web` using live interaction.
- Covered: auth, sandbox list/detail/create, issue list views, repository views, profile views,
  theme controls, responsive behavior (desktop + mobile), and error paths.
- Test account used: `user@email.com` / `password`.

## Take

- The product already has a strong operational voice and clear desktop information hierarchy.
- The core sandbox flow is compelling in intent, but trust drops in key moments due to navigation,
  state, and error-handling inconsistencies.
- UI maturity is uneven: sandboxes feel closest to real product depth; issues, profiles, and
  repository-linked workflows still feel partially synthetic.
- Mobile behavior is currently a blocking gap for realistic operator usage.

## What Works Well

- Copy is specific and action-oriented in most surfaces (good operational tone).
- Page structure is consistent: context header -> decision metrics -> actionable list/detail.
- Sandbox creation has a credible control-plane feel:
  - Explicit configuration sections
  - Live preview and health checks
  - Immediate transition into sandbox detail after launch
- Sandbox detail consolidates useful runtime context (attempts, events, output refs, spec summary)
  in one place.

## Friction and Breakpoints Observed

## 1) Flow Integrity

- Repository sandbox links can route to non-existent entities (`/sandboxes/run-1042`), causing a raw
  error boundary instead of a guided recovery.
- `View Spec` button in sandbox detail toggles active state but does not navigate; side-nav `Spec`
  link does navigate.
- Search input appears present but non-functional in tested scenarios (no observable result state).

## 2) State Consistency

- Status representations diverge between surfaces during transitions:
  - A sandbox appeared as `Failed` in recent-nav context while list-level metrics still showed
    `Running: 1`, `Failed: 0`.
- This suggests stale or differently-sourced state across shell/sidebar/main panels.

## 3) Error Experience

- Error fallback for broken sandbox links is technical and abrupt (`Something went wrong!` + raw
  error text) without recovery options.
- Console error path is obvious in dev, but product UX does not provide user-level explanation,
  ownership, or next action.

## 4) Responsive/Mobile

- At mobile viewport, authenticated pages can render without visible shell navigation, leaving only
  route content and no practical way to traverse product areas.
- This is a severe usability blocker for any real multi-step workflow on mobile.

## 5) Cognitive Load in Sandbox Creation

- The form is powerful but heavy for first-run users:
  - Many advanced controls are surfaced at once
  - Raw JSON preview is dense and hard to parse quickly
- The flow feels optimized for power users, less for progressive onboarding.

## Deeper Implications

## A) Product Trust Is Currently Fragile at Domain Boundaries

- Within a single surface, the UI is clear.
- Across surfaces (repositories -> sandboxes, lists -> detail, summary -> spec), broken routing and
  state drift undermine confidence.
- Implication: users may perceive orchestration as unreliable even when backend execution is
  functioning.

## B) The UI Shows Two Competing Realities

- One reality is a serious control-plane product (sandbox create/detail).
- The other is a partially staged/demo ecosystem (some issue/repo/profile interactions, broken
  linked runs).
- Implication: the app risks being interpreted as a demo shell around a real sandbox core.

## C) Domain Model Drift Is Leaking Into UX

- User-visible entities alternate between "sandbox" and "run" semantics in navigation paths and
  labels.
- Broken run-linked routes suggest mismatched identity contracts between screens.
- Implication: mental model fragmentation for operators and higher support burden.

## D) The Design System Is Directionally Strong but Governance Is Loose

- The visual system often matches the intended operational tone.
- But exposed accent controls and multiple accent choices conflict with strict single-accent
  guidance and can dilute brand consistency.
- Implication: teams can unintentionally diverge from the intended language without guardrails.

## E) Mobile Is Not Just a Layout Problem

- Missing navigation on mobile is not cosmetic; it breaks workflow continuity.
- Implication: no credible "on-call/operator from mobile" story, even for triage-only tasks.

## Guidance Relative to Project Contracts

## Product Language Contract (sandboxes + issue workflows)

- Sandboxes: materially represented and closest to end-to-end credibility.
- Issue workflows: currently shallow in interaction depth (mostly list views + "Open sandboxes"
  bridge), with little lifecycle depth visible in UI.
- Guidance: prioritize a true issue workflow lifecycle surface rather than additional static list
  variants.

## DESIGN.md Alignment (Swiss operational poster language)

- Alignments:
  - Strong hierarchy and operational copy on major pages
  - Rule-driven sectioning and dense-but-readable desktop layouts
  - Good action-first framing in headers and metrics
- Misalignments / risks:
  - Mobile hierarchy/navigation parity gaps
  - Raw technical error boundaries instead of structured operational recovery
  - Accent/theme controls that can drift from the single-accent discipline
  - Dense raw JSON without readable structure in high-stress moments

## Recommended Direction (Prioritized)

## P0 (Trust and Flow Integrity)

1. Guarantee route integrity between repositories/profiles/issues and sandbox detail targets.
2. Replace raw error boundary with domain-specific recovery states (not found, unavailable,
   permission, stale link).
3. Fix `View Spec` behavior parity (button and side-nav must produce same route action).
4. Establish one status source-of-truth for shell/sidebar/main to prevent contradictory states.

## P1 (Workflow Completion)

1. Deepen issue workflow surface (issue detail, status transitions, assignment/ready lifecycle,
   sandbox linkage history).
2. Introduce progressive disclosure in sandbox creation (`Basic` vs `Advanced`) while preserving
   expert controls.
3. Make manifest preview scannable (formatted JSON, copy/download actions, key highlights).

## P2 (Design Governance and Quality Bar)

1. Enforce design-system constraints in code (theme/accent policy, mobile nav invariants).
2. Add UI acceptance checks tied to DESIGN.md (mobile nav presence, state consistency, route
   validity, recovery state quality).
3. Remove or gate dev-only chrome from product sessions where appropriate.

## Suggested Near-Term Acceptance Criteria

- No cross-surface link routes to missing sandbox IDs without a guided recovery path.
- Mobile authenticated shell always exposes reachable global navigation.
- A sandbox status shown in any shell region matches the detail page status in the same refresh
  window.
- Sandbox creation supports a low-cognitive default path while retaining advanced controls.
- Issue workflow has at least one end-to-end actionable lifecycle path visible in UI.

## Closing Note

The strongest signal is that the team already has the right visual and product instincts. The next
step is not more surface area; it is reliability of transitions between surfaces. If flow integrity,
state consistency, and mobile navigation are fixed first, the existing design language will read as
intentional and trustworthy rather than "almost there."
