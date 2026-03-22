# Swiss Operational Poster Design Language

Version: 1.1 Owner: Product Design + Frontend Applies to: auth flows, workspace surfaces, component
library, content style

## 1) Design Intent

This system defines our chosen aesthetic: **Swiss structure + poster energy + operational clarity**.

We do not design for decoration first. We design for confidence in operational software where speed,
clarity, and trust matter.

### The core feel

- **Structured**: rigid grid, clear hierarchy, strong section boundaries
- **Expressive in key moments**: oversized condensed display type for headlines
- **Minimal but not sterile**: enough information density to be useful, never noisy
- **Operational**: content is concrete, measurable, and action-oriented
- **Brand-forward**: the Sealant mark, wordmark, and accent red should read instantly at shell level

### What this is not

- Not soft lifestyle minimalism
- Not glossy startup gradient UI
- Not decorative editorial without utility
- Not dashboard clutter
- Not marketing-first storytelling inside product surfaces

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

### Runtime themes

The system now ships in both light and dark themes. The accent stays fixed; neutrals invert.

| Token            | Light     | Dark      |
| ---------------- | --------- | --------- |
| `--sw-bg`        | `#fbfbfa` | `#121211` |
| `--sw-panel`     | `#ffffff` | `#191917` |
| `--sw-ink`       | `#111111` | `#f1f1ef` |
| `--sw-muted`     | `#767676` | `#afaea9` |
| `--sw-rule`      | `#141414` | `#f1f1ee` |
| `--sw-soft-rule` | `#e4e4e4` | `#383835` |
| `--sw-accent`    | `#d92f24` | `#d92f24` |

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
- Preserve the same hierarchy and component geometry across light and dark themes

### Do not

- Introduce additional saturated accent colors
- Use low-contrast gray-on-gray combinations
- Treat dark mode as a separate visual language

## 4.2 Typography

Typography is the main identity layer.

### Font roles

- **Display**: `Bebas Neue` for high-impact headlines and numeric marks
- **Body/UI**: `Plus Jakarta Sans` for readability, controls, and long-form text
- **Mono/meta**: `Geist Mono` for utility labels, versioning, compact metadata, and theme controls
- **Support fallback**: `Space Grotesk` can support mono/display-adjacent moments when system stacks
  require it

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
- Use monospace sparingly for utility chrome, not for large reading blocks

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
- Keep shell spacing tight enough that navigation, search, theme controls, and account actions live
  on one line on desktop

## 4.4 Rules, Borders, Geometry

Our system uses lines as structure.

- Heavy rule: `2px solid var(--sw-rule)` for major layout boundaries
- Soft rule: `1px solid var(--sw-soft-rule)` for internal segmentation
- Border radius: minimal to none (keep geometry crisp)

### Do

- Use rule-based separation to define zones
- Use square corners and flat surfaces so borders, rails, and active states carry the interface

### Do not

- Replace structure with shadows or floating cards everywhere
- Introduce soft glass, blur-heavy, or rounded card styling as a default pattern

## 4.5 Brand Signature

The product now has a defined Sealant mark and wordmark system.

- **Blob mark**: black/white circular form with red directional bars; works in both light and dark
  themes
- **Wordmark**: custom `Plus Jakarta Sans` drawing, not generic text treatment
- **Placement**: use mark + wordmark together in primary shell headers; mark alone is acceptable in
  constrained spaces
- **Behavior**: branding should remain static and crisp; no decorative animation on the logo

---

## 5) Layout Grammar

## 5.1 Grid

- Desktop: asymmetrical split grids (for example `1.45fr / 1fr`) are preferred
- Mid-size: preserve structural split where possible
- Mobile: collapse to single column while keeping section order

## 5.2 Structural pattern

Most pages should follow this flow:

1. Nav with clear utility action
2. Context header with statement + supporting operational content
3. Primary data or workflow surface
4. Secondary navigation or detail panels
5. Focused next action

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
- Global active state should resolve through border or underline, not pills

### Do

- Keep nav quiet and stable

### Do not

- Overpopulate with too many primary actions

## 6.1A Workspace App Shell

This is the default pattern for authenticated product surfaces.

### Structure

- Sticky top bar with brand, global navigation, search, theme switcher, account chip, and one
  utility action
- Fixed left sidebar for context-specific navigation groups
- Scrollable main pane with simple page padding

### Style

- Use a thin grid or dot-field overlay behind the shell, at low contrast only
- Keep header and sidebar slightly separated with borders, not elevation
- Use accent red for active area indicators and the primary utility action only

### Do

- Make section labels small, uppercase, and rule-separated
- Keep the shell readable in both themes without moving components around

### Do not

- Turn navigation into rounded chips or filled tabs
- Hide primary navigation behind menus on desktop

## 6.1B Auth Shell

### Structure

- Full-height split composition with poster headline on the left and form card on the right
- Top rail accent and strong header rule
- Theme switcher visible in the shell, not buried in the form

### Do

- Let the headline carry the drama and keep the form panel restrained

### Do not

- Center a small auth card in empty space without structural rails

## 6.2 Page Header

### Structure

- Kicker or context label
- Headline
- Short operational description
- Optional primary action or metric strip

### Content rules

- Headline: short, declarative, outcome-driven
- Supporting copy: concrete capabilities, no vague abstraction
- Metrics: only include numbers that help the next decision

### Do

- Use one clear claim and one clear proof layer

### Do not

- Stack multiple competing messages in the header

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

## 6.3A Theme Switcher

### Structure

- Segmented control with `Light`, `Dark`, and `System`
- Small icon + label in each segment

### Interaction

- Update theme immediately in place
- Persist user choice and honor system preference when `System` is selected

### Do

- Keep the control rectangular, bordered, and utility-scaled

### Do not

- Use dropdowns or modal settings for a top-level theme choice

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

## 6.5 Data List / Table

### Structure

- Left rail label + right content rows
- Row columns: identifier, title, status, detail, owner, or last activity

### Content

- Details must be action-level and specific
- Owners should clarify who benefits
- Status values should be scannable in one glance

### Interaction

- Mild hover translation is acceptable
- Hover should reinforce hierarchy, not introduce flashy motion

### Do

- Keep scanning left-to-right predictable
- Make row selection and drill-in affordances obvious

### Do not

- Turn module rows into overloaded card mosaics
- Hide critical status information behind hover-only affordances

## 6.6 Detail Section

### Structure

- Section title
- Compact metadata or actions
- Dense but readable content area

### Content

- Break dense information into titled blocks
- Prefer labels and values over paragraph-heavy explanations

### Do

- Use rule-separated groups for specs, traces, validation, and settings

### Do not

- Turn detail views into unstructured walls of text

## 6.7 Empty / Placeholder States

### Structure

- Short title
- One explanatory sentence
- One clear recovery or creation action

### Do

- Explain what the user can do next immediately

### Do not

- Fill empty states with decorative illustration as the primary message

## 6.8 Status and Metadata

### Structure

- Use compact uppercase or mono labels for status, version, and utility metadata
- Reserve accent red for primary action or critical emphasis, not for every status

### Do

- Keep metadata compact and secondary to page title or data

### Do not

- Let metadata compete with core content hierarchy

## 6.9 Workspace Page Header Block

### Structure

- Full-width rectangular panel
- Thin accent rail at top
- Title, short description, optional metric strip

### Content

- Titles should be concise and operational
- Metrics should be few, high-signal, and directly tied to the page decision space

### Do

- Use metrics as a quick orientation layer before the detailed content

### Do not

- Add decorative hero treatments to routine workspace pages

---

## 7) Interaction and Motion

Motion should support orientation and affordance, not entertainment.

### Allowed motion

- Subtle hover color transitions (`~180-220ms`)
- Small horizontal shifts on list hover (`~4-8px` feel)
- State transitions for segmented controls
- Theme changes should feel immediate; avoid theatrical crossfades

### Avoid

- Continuous ambient animations
- Bounce/spring-heavy microinteractions
- Delayed interactions that slow decision flow

---

## 8) Responsive Behavior

## 8.1 Desktop to tablet

- Preserve section hierarchy
- Collapse non-critical nav links before reducing core CTA visibility
- Hide or compress secondary utilities such as search before compromising the brand + nav structure

## 8.2 Mobile

- Move to single-column flow
- Keep headline impact without overwhelming viewport
- Stack dense rows and metadata cleanly with clear separators

### Must-have checks

- Buttons remain tappable
- Labels remain legible
- No clipped display typography
- No horizontal scroll
- Theme switcher remains usable without relying on hover

---

## 9) Content and Copy Rules

Tone: direct, practical, credible.

### Writing standards

- Prefer verbs over adjectives
- Explain outcomes, not vague promises
- Keep claims specific and testable
- Use short sentences where possible

### Good examples

- "Inspect the full run trace without leaving the current workspace view."
- "Switch profiles and compare setup details without losing context."

### Bad examples

- "A revolutionary platform for next-generation infrastructure workflows."
- "Transform developer velocity with game-changing orchestration."

### Do

- Write so an operator can act immediately

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
9. Theme-specific component layouts that break parity between light and dark
10. Generic text logos when the Sealant brand mark should be present
11. Product docs that describe components we do not actually ship

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
- [ ] Does the UI preserve the same structure in both light and dark themes?
- [ ] Is hierarchy obvious without needing animation?
- [ ] Is copy specific, concrete, and free of fluff?
- [ ] Are lines/rules doing the structural work?
- [ ] Are interactive elements obvious and semantic?
- [ ] Does mobile preserve readability and hierarchy?
- [ ] Are there any decorative elements that do not serve function?
- [ ] Is branding using the Sealant mark/wordmark correctly?

If any answer is "no", revise before merge.

---

## 14) Final Standard

Every component should feel like it belongs to one coherent system:

- **Swiss discipline in structure**
- **Poster confidence in headline moments**
- **Operational clarity in content**

If it looks stylish but cannot be scanned quickly, it fails. If it is clear but visually generic, it
fails. If it is expressive but not useful, it fails.

This design language exists to keep us in the narrow, intentional space where all three are true.
