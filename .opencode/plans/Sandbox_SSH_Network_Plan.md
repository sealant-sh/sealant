# Sealant Sandbox SSH and Network Control Plan

## Problem Statement

Current sandbox SSH access has three blockers:

1. Known hosts churn: every new sandbox host identity requires trust updates.
2. Port collisions: different sandboxes can conflict when they reuse local SSH ports.
3. Developer workflow friction: CLI SSH and VS Code Remote SSH are unreliable at scale.

At the same time, we need a path toward network policy controls and centralized auth handling so
sandboxes do not carry long-lived credentials.

## Goals

- Remove per-sandbox SSH port conflicts.
- Avoid mutating users' default `~/.ssh/known_hosts`.
- Make SSH stable for both terminal and VS Code Remote SSH.
- Build a foundation for future sandbox egress policy and gateway-level auth injection.

## Non-Goals (This Phase)

- Full implementation of egress policy engine.
- Full TLS MITM for all outbound traffic.
- Broad sandbox runtime redesign beyond connectivity and routing needs.

## Principles

- Preserve user control of default SSH trust files.
- Require at most one-time onboarding for local SSH config.
- Keep standards-compatible OpenSSH behavior.
- Design for multi-tenant isolation and auditable access paths.

## Candidate Approaches

### Option A: Sealant-Scoped SSH Files Only

- Keep current per-sandbox connectivity model.
- Store generated config and trust in:
  - `~/.config/sealant/ssh_config`
  - `~/.config/sealant/known_hosts`
- Add one-time SSH include in user config.

Pros:

- Fastest to ship.
- Stops writes to default `~/.ssh/known_hosts`.

Cons:

- Known-host lifecycle still exists (just moved).
- Port collision problem remains unless solved separately.

### Option B: Single SSH Gateway with Sandbox Routing

- Expose one stable endpoint (for example `ssh.sealant.dev` on `22` and/or `443`).
- Route traffic by sandbox identity (`sbx-<id>.sandboxes.sealant.dev` or SSH principal).
- Use sandbox outbound connectivity to gateway (reverse tunnel/agent model).

Pros:

- Eliminates per-sandbox SSH port collisions.
- Stable endpoint for users and VS Code.
- Natural control point for future policy and audit.

Cons:

- Requires gateway service, routing, and session lifecycle management.

### Option C: SSH Host Certificates (with Option B)

- Introduce Sealant SSH Host CA.
- Issue short-lived host certificates for sandbox identities.
- Users trust CA once in Sealant-scoped SSH config.

Pros:

- Eliminates per-sandbox known-host churn.
- Strong security posture with short-lived certs.
- Scales cleanly with sandbox count.

Cons:

- Adds CA operational responsibilities (rotation, issuance, revocation process).

### Option D: Overlay Network per Sandbox

- Assign unique private addresses via WireGuard/Tailscale-like architecture.
- Route SSH over overlay instead of public endpoints.

Pros:

- Strong isolation and clean addressing model.
- Flexible long-term networking base.

Cons:

- Higher operational complexity and client setup burden.

## Recommended Direction

Adopt Option B + Option C:

1. Move sandbox access behind a single SSH gateway.
2. Use host certificates to avoid per-sandbox trust churn.
3. Keep all SSH artifacts in Sealant-managed config paths rather than user default files.

This combination directly resolves current blockers while aligning with future policy and identity
goals.

## Target Architecture (High Level)

- Client (`ssh`, VS Code) uses a stable sandbox hostname pattern.
- OpenSSH config includes Sealant-managed entries from `~/.config/sealant/ssh_config`.
- Gateway authenticates request context and maps sandbox identity to active backend session.
- Sandbox (or sandbox sidecar) maintains outbound secure channel to gateway.
- Host identity is validated via Sealant Host CA certificates.

## Phased Rollout

### Phase 0: Design Decisions

- Finalize canonical sandbox naming format.
- Finalize gateway ports (`22`, `443`, or both).
- Define host cert TTL and CA rotation policy.

### Phase 1: UX Stabilization

- Move SSH config/trust to Sealant-scoped files.
- Stop default `~/.ssh/known_hosts` writes.
- Keep current backend connection method temporarily.

### Phase 2: Gateway Adoption

- Deploy SSH gateway with sandbox routing.
- Support standard VS Code Remote SSH flows.
- Migrate active sandboxes progressively.

### Phase 3: Host Certificate Adoption

- Enable host cert issuance for sandbox identities.
- Remove per-sandbox host key pinning workflow.
- Add cert issuance and expiry monitoring.

### Phase 4: Policy-Ready Egress Path

- Route sandbox egress through policy gateway.
- Start with allowlist/report-only controls and audit logging.
- Add destination-specific auth connectors for key integrations.

## Future: Egress Policy and Auth Injection

- Enforce outbound controls at gateway/policy layer, not app code inside sandbox.
- Prefer identity-based request signing and credential injection at gateway.
- Keep long-lived secrets out of sandbox filesystem/runtime.
- Prefer connector-based auth mediation over broad TLS MITM.

Note: full generic TLS MITM should be treated as optional and high-friction due to trust-store,
privacy, and compliance overhead.

## Risks and Mitigations

- Gateway critical path risk:
  - Mitigate with HA deployment, health checks, and observability.
- CA misconfiguration risk:
  - Mitigate with short cert lifetimes, strict issuance policy, and rotation drills.
- Migration complexity:
  - Mitigate with dual-mode transition period and explicit operator runbook.
- Tooling compatibility edge cases:
  - Mitigate with reference SSH templates and VS Code validation tests.

## Success Criteria

- Zero sandbox SSH port collision incidents.
- No Sealant writes to default `~/.ssh/known_hosts`.
- New sandbox SSH access works without manual host-key cleanup.
- VS Code Remote SSH works through stable aliases.
- Egress policy enforcement path is available for incremental rollout.

## Open Decisions

1. Should gateway listen on `22`, `443`, or both?
2. What sandbox hostname format should be canonical?
3. What host certificate TTL is right for operations and security?
4. Do we enforce one-time CLI onboarding for SSH include setup?
5. Which policy launch mode comes first: report-only or enforce allowlist?
