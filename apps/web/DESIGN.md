# Swiss Operational Poster Design Language

Version: 1.0
Owner: Product Design + Frontend
Applies to: Marketing pages, product surfaces, component library, content style

## 1) Design Intent

This system defines our chosen aesthetic: **Swiss structure + poster energy + operational clarity**.

We do not design for decoration first. We design for confidence in live-service environments (kitchens, bars, floor teams) where speed, clarity, and trust matter.

### The core feel

- **Structured**: rigid grid, clear hierarchy, strong section boundaries
- **Expressive in key moments**: oversized condensed display type for headlines
- **Minimal but not sterile**: enough information density to be useful, never noisy
- **Operational**: content is concrete, measurable, and action-oriented

### What this is not

- Not soft lifestyle minimalism
- Not glossy startup gradient UI
- Not decorative editorial without utility
- Not dashboard clutter

---

## 2) Design Principles

1. **Clarity over cleverness**
   - A user should understand the purpose of a section in less than 3 seconds.
2. **Hierarchy over novelty**
   - Visual order comes first. Distinctive style is layered on top.
3. **Structure over ornament**
   - Rules, spacing, and alignment create identity more than effects.
4. **Function over filler**
   - Every element must either inform, orient, or move a decision forward.
5. **One accent, used with intent**
   - Red is directional, not decorative.
6. **Type does the heavy lifting**
   - Typography should establish rhythm before color does.
7. **Contrast is non-negotiable**
   - Text and UI states must be legible under stress and speed.
8. **Calm density**
   - Rich content is allowed, but every block must stay scannable.

---

## 3) Brand Personality to Translate in UI

- Precise
- Useful
- Confident
- Grounded
- Fast
- Unfussy

Use these traits as acceptance criteria for every component.

---

## 4) Visual Foundations

## 4.1 Color System

Use a neutral-first palette with a single assertive accent.

### Core tokens

| Token            |     Value | Purpose                              |
| ---------------- | --------: | ------------------------------------ |
| `--sw-bg`        | `#fbfbfa` | Global page background               |
| `--sw-panel`     | `#ffffff` | Card and section surface             |
| `--sw-ink`       | `#111111` | Primary text and UI ink              |
| `--sw-muted`     | `#767676` | Secondary text                       |
| `--sw-rule`      | `#141414` | Heavy boundaries and key separators  |
| `--sw-soft-rule` | `#e4e4e4` | Soft separators within data blocks   |
| `--sw-accent`    | `#d92f24` | Primary accent, CTA, active emphasis |

### Color usage rules

- Use accent red for:
  - Primary actions
  - Active tabs/states
  - Small, high-importance labels
  - Targeted numeric emphasis
- Do not use accent red for:
  - Large body text blocks
  - Decorative backgrounds
  - Multiple competing highlights in one viewport

### Do

- Keep 80-90% of UI neutral
- Use red to guide behavior and focus

### Do not

- Introduce additional saturated accent colors
- Use low-contrast gray-on-gray combinations

## 4.2 Typography

Typography is the main identity layer.

### Font roles

- **Display**: `Bebas Neue` for high-impact headlines and numeric marks
- **Body/UI**: `Geist` for readability, controls, and long-form text

### Typographic hierarchy

1. Hero display (largest, condensed, uppercase)
2. Section display heads (large, condensed)
3. Feature titles (uppercase, bold, compact)
4. Body copy (normal case, neutral tone)
5. Labels/meta (small uppercase, letter-spaced)

### Recommended settings

- Display line-height: `0.82 - 0.92`
- Display letter-spacing: `0.00em - 0.03em`
- Body line-height: `1.6 - 1.72`
- Label letter-spacing: `0.08em - 0.13em`

### Do

- Use uppercase intentionally for labels, titles, and controls
- Let large type create rhythm and section anchors

### Do not

- Mix many font families
- Use ultra-light body text on light backgrounds

## 4.3 Spacing and Rhythm

Use a consistent spacing scale. Favor generous section padding and tighter intra-component spacing.

### Suggested spacing scale

`4, 8, 12, 16, 20, 24, 32, 40, 56, 64, 72, 86`

### Rhythm rules

- Large sections should have clear top/bottom breathing room
- Internal list rows should be compact and repeatable
- Breakpoints should preserve hierarchy, not just shrink everything

## 4.4 Rules, Borders, Geometry

Our system uses lines as structure.

- Heavy rule: `2px solid var(--sw-rule)` for major layout boundaries
- Soft rule: `1px solid var(--sw-soft-rule)` for internal segmentation
- Border radius: minimal to none (keep geometry crisp)

### Do

- Use rule-based separation to define zones

### Do not

- Replace structure with shadows or floating cards everywhere

---

## 5) Layout Grammar

## 5.1 Grid

- Desktop: asymmetrical split grids (for example `1.45fr / 1fr`) are preferred
- Mid-size: preserve structural split where possible
- Mobile: collapse to single column while keeping section order

## 5.2 Structural pattern

Most pages should follow this flow:

1. Nav with clear utility action
2. Hero with statement + supporting operational content
3. Product proof block (interactive or data-backed)
4. Module/system list
5. Social proof
6. Focused CTA
7. Tight footer

## 5.3 Section boundaries

Every major section must have a clear top or bottom boundary rule.

### Do

- Make section starts and ends obvious

### Do not

- Let sections bleed visually without structure

---

## 6) Component Construction Standards

This section defines how components should be structured visually and behaviorally.

## 6.1 Navigation

### Structure

- Left: brand
- Center: compact utility links
- Right: single utility action

### Style

- Uppercase micro UI type
- Strong bottom rule
- No heavy decorative treatments

### Do

- Keep nav quiet and stable

### Do not

- Overpopulate with too many primary actions

## 6.2 Hero

### Structure

- Left pane: kicker, display headline, concise value statement, primary actions
- Optional metrics strip under CTA area
- Right pane: one dominant typographic mark + one concise explanatory block

### Content rules

- Headline: short, declarative, outcome-driven
- Supporting copy: concrete capabilities, no vague abstraction

### Do

- Use one clear claim and one clear proof layer

### Do not

- Stack multiple competing messages in hero

## 6.3 Buttons

### Primary

- Filled accent background
- Uppercase label
- Tight letter spacing

### Secondary

- Transparent background
- Ink border

### Interaction

- Hover can invert or accent-fill
- Keep transitions fast (`~200ms`)

### Do

- Keep button copy action-first (`Create Free Account`, `See Live Demo`)

### Do not

- Use generic labels like `Learn More` when a stronger intent is possible

## 6.4 Metric Strip

### Structure

- Equal columns
- Label above value
- Soft internal dividers

### Content

- Numbers must be interpretable and context-relevant
- Avoid unexplained vanity metrics

### Do

- Use 2-4 metrics max in one row

### Do not

- Fill with stats that do not support user decisions

## 6.5 Interactive Costing Panel

This is a key component in our system.

### Purpose

Show one mental model that works across **cocktails, dishes, and house prep**.

### Required anatomy

1. Mode switcher (compact segmented controls)
2. Item header (name + context)
3. Ingredient rows (name, amount, cost)
4. KPI row (3 concise metrics)
5. One note line for operational context

### Behavioral rules

- Mode switch updates all panel content in place
- No page jump, no modal, no hidden complexity
- Default mode should match most common use case

### Visual rules

- Keep panel rectangular and rule-driven
- Keep controls small and uppercase
- Avoid decorative charts unless they add immediate decision value

### Do

- Keep interactions immediate and obvious

### Do not

- Add multi-step complexity inside this panel

## 6.6 Module List

### Structure

- Left rail label + right content rows
- Row columns: index, title, detail, owner

### Content

- Details must be action-level and specific
- Owners should clarify who benefits

### Interaction

- Mild hover translation is acceptable
- Hover should reinforce hierarchy, not introduce flashy motion

### Do

- Keep scanning left-to-right predictable

### Do not

- Turn module rows into overloaded card mosaics

## 6.7 Testimonial Block

### Structure

- Oversized quote mark + short quote + citation

### Content

- Keep language concrete and believable
- Prefer outcome and workflow clarity over hype

### Do

- Keep testimonial brief

### Do not

- Use generic, vague praise

## 6.8 CTA Block

### Structure

- Large display statement
- One sentence support
- Single dominant action

### Do

- Focus on one conversion goal

### Do not

- Introduce secondary distractions in final CTA

## 6.9 Footer

### Structure

- Lightweight, rule-separated
- Utility-level metadata only

### Do

- Keep footer compact and quiet

### Do not

- Repeat full navigation or promotional content

---

## 7) Interaction and Motion

Motion should support orientation and affordance, not entertainment.

### Allowed motion

- Subtle hover color transitions (`~180-220ms`)
- Small horizontal shifts on list hover (`~6-12px` feel)
- State transitions for segmented controls

### Avoid

- Continuous ambient animations
- Bounce/spring-heavy microinteractions
- Delayed interactions that slow decision flow

---

## 8) Responsive Behavior

## 8.1 Desktop to tablet

- Preserve section hierarchy
- Collapse non-critical nav links before reducing core CTA visibility

## 8.2 Mobile

- Move to single-column flow
- Keep headline impact without overwhelming viewport
- Stack dense rows cleanly with clear separators

### Must-have checks

- Buttons remain tappable
- Labels remain legible
- No clipped display typography
- No horizontal scroll

---

## 9) Content and Copy Rules

Tone: direct, practical, credible.

### Writing standards

- Prefer verbs over adjectives
- Explain outcomes, not vague promises
- Keep claims specific and testable
- Use short sentences where possible

### Good examples

- "Update one ingredient price and see margin changes across the full menu instantly."
- "Generate pre-service briefs with reservations, 86s, VIP notes, and prep checkpoints."

### Bad examples

- "Revolutionary hospitality intelligence for next-level teams."
- "Transform your operations with game-changing innovation."

### Do

- Write so a shift manager can act immediately

### Do not

- Use filler, hype, or abstract language

---

## 10) Accessibility Standards

- Maintain WCAG AA contrast for all text and controls
- Provide clear focus states for keyboard navigation
- Ensure interactive controls have semantic HTML (`button`, etc.)
- Keep interactive labels explicit and understandable out of context
- Avoid meaning encoded by color alone

### Content accessibility

- Use plain language
- Avoid ambiguous abbreviations unless domain-standard

---

## 11) Anti-Patterns (Global Do Not Use)

1. Multiple accent colors in one viewport
2. Decorative gradients as primary background language
3. Rounded, soft card-heavy UI that removes Swiss rigor
4. Centered-everything layouts without structural rails
5. Ambiguous metrics without context
6. Long hype copy blocks
7. Over-animated interactions
8. Dense component stacking without separators

---

## 12) Component Definition Template (For New Work)

When adding a new component, define it using this checklist:

1. **Purpose**: What decision does it help make?
2. **Placement**: Where in page hierarchy does it live?
3. **Anatomy**: Required subparts (header/body/meta/actions)
4. **Content contract**: Max lengths, required fields, optional fields
5. **States**: default, hover, active, focus, disabled, empty
6. **Responsive behavior**: desktop/tablet/mobile structure
7. **Accessibility**: keyboard, semantics, contrast, labels
8. **Do/Do not list**: explicit guardrails

No component should ship without this definition.

---

## 13) QA Review Checklist

Before shipping UI:

- [ ] Does the layout read as Swiss-structured at first glance?
- [ ] Is the accent red used sparingly and intentionally?
- [ ] Is hierarchy obvious without needing animation?
- [ ] Is copy specific, concrete, and free of fluff?
- [ ] Are lines/rules doing the structural work?
- [ ] Are interactive elements obvious and semantic?
- [ ] Does mobile preserve readability and hierarchy?
- [ ] Are there any decorative elements that do not serve function?

If any answer is "no", revise before merge.

---

## 14) Final Standard

Every component should feel like it belongs to one coherent system:

- **Swiss discipline in structure**
- **Poster confidence in headline moments**
- **Operational clarity in content**

If it looks stylish but cannot be scanned quickly, it fails.
If it is clear but visually generic, it fails.
If it is expressive but not useful, it fails.

This design language exists to keep us in the narrow, intentional space where all three are true.
