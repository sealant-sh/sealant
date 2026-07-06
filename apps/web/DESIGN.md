# Evidence Review — Design Language

Version: 3.0 (depth & polish) · Owner: Product Design + Frontend · Applies to: `@sealant/ui`, web
app, marketing site, content style.

This is the visual language of an **evidence-backed review surface** for AI software runs: warm +
premium, with real depth. It keeps the colour discipline and the "evidence beside the claim" ethos
of the original review tool, but trades the flat/structural look for a polished, elevated, dev-infra
aesthetic (think Linear / Vercel / Stripe-grade). The canonical built reference is
**`apps/marketing/src/routes/index.tsx`** — match its depth, spacing, type, and the run-record
motif. This document is the implementation contract.

---

## 0. Principles

1. **Evidence beside the claim.** A reviewer never carries a value from one place to verify it in
   another. The thing and its proof share one viewport.
2. **The tool reports, it does not judge.** Show observations, never verdicts. No confidence scores,
   no "safe to merge," no risk dials. The reviewer decides.
3. **Hierarchy from depth and space.** Panels lift off the warm canvas; generous whitespace and
   elevation group content. Avoid decorative containers (pills, chips, metric tiles) that
   manufacture hierarchy the layout already has.
4. **Color is earned.** Each accent marks exactly one meaning. No region is ever flooded with it.
5. **Type does the work.** Space Grotesk for display, Inter for UI, JetBrains Mono for machine
   facts. The split is semantic, not decorative.

---

## 1. Color

A warm near-white canvas, near-black ink, pale warm rules. One cobalt brand accent. Three earned
semantic colors. Nothing decorative carries color.

All values live as CSS custom properties in `packages/ui/src/styles/globals.css`. **Reference
tokens, never raw hexes**, in app/component code (`bg-background`, `text-muted-foreground`,
`text-[var(--sw-accent)]`, `text-success`, …).

### Surfaces & neutrals (light)

| Token         | Hex       | Role                                          |
| ------------- | --------- | --------------------------------------------- |
| `--sw-canvas` | `#edeae4` | Outer page gutter, behind the working sheet   |
| `--sw-bg`     | `#faf9f7` | Primary working sheet — the dominant surface  |
| `--sw-panel`  | `#ffffff` | Raised panels / overlays / drawers / sidebar  |
| `--sw-sunken` | `#f1eee8` | Recessed bars, hover fills, muted backgrounds |
| `--sw-wash`   | `#f4f6fd` | Cobalt wash — selection, active nav, info     |

### Text ramp (light)

| Token        | Hex       | Role                          | shadcn bridge        |
| ------------ | --------- | ----------------------------- | -------------------- |
| `--sw-ink`   | `#1b1b1d` | Primary text                  | `--foreground`       |
| `--sw-ink-2` | `#3b3b40` | Secondary text                | `text-ink-2`         |
| `--sw-muted` | `#6e6e76` | Tertiary text / quiet actions | `--muted-foreground` |
| `--sw-label` | `#8a8a92` | Section labels                | `text-label`         |
| `--sw-faint` | `#9a9aa2` | Mono dim / placeholders       | `text-faint`         |

### Rules (light)

| Token             | Hex       | Role                               |
| ----------------- | --------- | ---------------------------------- |
| `--sw-rule`       | `#cbc8c1` | Strong hairline / input border     |
| `--sw-soft-rule`  | `#e4e1db` | Hairline — panel & section divider |
| `--sw-faint-rule` | `#eceae4` | Innermost row dividers             |

There are **no heavy black rules** in this system. The heaviest line is a 1px warm hairline.

### Accents — one meaning each

| Color  | Token(s)                                | Means                  | Discipline                                                       |
| ------ | --------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| Cobalt | `--sw-accent` `#2052cc`                 | Interaction, selection | The only brand color. Marks what is active or clickable.         |
| Amber  | `--sw-amber` `#cf9a18` · text `#9a6700` | Unresolved judgment    | One prominent use at a time. A scenario reasoned about, not run. |
| Red    | `--sw-red` `#c0362c` · text `#b3261e`   | Demonstrated breakage  | Only an observed failure — never a generic warning.              |
| Green  | text `#2e7d46` · dot `#5f9e77`          | Observed success       | Only a result that was actually run.                             |

Semantic utilities are generated: `text-success` / `text-warning` / `text-danger` / `text-info`,
plus the dot colors `*-dot`. Cobalt is also `--primary` / `--ring`; red is also `--destructive`.

### Diff tints — edge marks, never floods

A 2px colored edge plus a faint wash carries the signal. Saturated blocks would render a verdict.

- Addition: bg `--sw-add-bg` `rgba(46,125,70,.07)`, edge `--sw-add-edge` `#2e7d46`
- Deletion: bg `--sw-del-bg` `rgba(192,54,44,.06)`, edge `--sw-del-edge` `#c0362c`
- Context: transparent

### Dark theme

The system ships light and dark. Dark is a **warm-dark counterpart with identical structure** — the
same tokens, neutrals inverted, cobalt brightened to read on dark (`#5781ea`). Never give dark a
different layout or component geometry. The accent meanings are unchanged.

---

## 2. Typography

Three voices. Display carries personality; UI stays neutral; mono is the recorder's voice.

- **Space Grotesk** (`--font-display`, use the `font-display` class) — display headlines and large
  page titles only, used with restraint. An engineered, technical grotesque with real presence.
  Weights 500 / 600 / 700, tight tracking (`-0.02em` to `-0.03em`).
- **Inter** (`--font-sans`) — all UI, labels, prose, controls, small headings. Weights 400/500/600.
- **JetBrains Mono** (`--font-mono`) — everything the recorder observed or executed: values, paths,
  SHAs, commands, numeric output, IDs, status meta. Weights 400 / 500.

### Scale

| Use                     | Spec                       |
| ----------------------- | -------------------------- |
| Change / page title     | 22–33px · 600 · `-0.016em` |
| Body & statements       | 14.5px · 400 · 1.55        |
| Interface text/controls | 13px · 400–500             |
| Section label           | 12px · 500 · `--sw-label`  |
| Machine value (mono)    | 12.5px · 400–500           |

The only place uppercase is allowed is the tiny mono **eyebrow** label (use the `.ev-eyebrow`
utility: mono, uppercase, `letter-spacing: .06em`, `--sw-label`). Everything else is sentence case.

---

## 3. Spacing & geometry

- 8px rhythm, used generously: `6 · 12 · 16 · 24 · 32 · 48 · 64`. Whitespace is the primary
  structure, ahead of rules; sections breathe (≈96px desktop). It is never empty padding.
- **Soft radius scale** (`--radius` = 12px): controls/inputs `rounded-lg`, cards `rounded-2xl`
  (~22px), hero/feature panels `rounded-3xl` (~28px). `rounded-full` only for genuine circles
  (avatars, status dots, the recording pulse) — never on buttons/badges/tabs.
- **Depth is real.** Panels lift off the warm canvas via the elevation scale (`shadow-xs`→`xl`).
  Cards rest at `shadow-sm` and rise on hover (`-translate-y-1` + `shadow-md`); floating overlays
  use `shadow-overlay`/`shadow-lg`. The signature **cobalt-lift** (`shadow-cobalt`) is reserved for
  the hero run-record and primary CTAs.
- Diff edges and dividers stay at radius `0`. Prefer space + a soft shadow over drawing yet another
  hairline rule.

---

## 4. Status — dot + word, never a glowing badge

Triage states are a colored dot plus a word. Never a tinted row, never a filled pill.

| State           | Dot                         | Text color | Means                               |
| --------------- | --------------------------- | ---------- | ----------------------------------- |
| Direct evidence | `--sw-green-dot` filled     | `#3f7d54`  | A result the system ran & observed. |
| Not executed    | `--sw-amber` filled         | `#9a6700`  | A scenario reasoned about, not run. |
| Breakage / oos  | `--sw-red` filled           | `#b3261e`  | An observed failure or stray edit.  |
| Not started     | hollow ring `1.5px #b3b0a8` | `#5b5b62`  | A disposition not yet made.         |

---

## 5. Components — how they must read

- **Page header** — an `.ev-eyebrow` kicker, a Space Grotesk title (`font-display`, ~28–40px, tight
  tracking), a one-line description, and an optional action on the right. Generous space below.
- **Buttons** — a weight hierarchy, sentence case, `rounded-xl`: `default` filled cobalt with the
  cobalt-lift shadow and a hover rise; `outline` a white panel + border that rises on hover; `ghost`
  / `link` quiet text actions. The one consequential action is filled; cheaper ones stay quiet.
- **Cards & panels** — white, `rounded-2xl`, resting on `shadow-sm`, lifting on hover. Group with
  space, not borders. Never a flat bordered slab.
- **The run-record panel (signature)** — the recurring evidence motif: a lifted white panel with a
  recording pulse + mono id in the header, a dot+word status, hairline-divided mono evidence rows,
  and (where relevant) a diff peek with 2px colored edge-marks. Build workspace/run detail from it.
- **Navigators / lists** — an elevated panel of rows: a mono index/id, a sans label, a dot+word
  status. Mild hover lift, never flashy motion.
- **Diff block** — mono, hairline header on `--sw-sunken`, 2px colored edge + faint wash per line.
- **Callouts** — a 2px colored left edge + text. Amber for an open question, red for breakage.

---

## 6. What the system refuses

Each was a live option, rejected. These are hard guardrails for every component and page.

- **No panel tinted green, amber, or red.** Color marks a value or a word; it never floods a region,
  because a tinted panel renders a verdict.
- **No more than one prominent warning** in a viewport. Two of equal weight means neither matters.
- **No vanity metric tiles, no pills/chips as containers.** Depth and type carry hierarchy; don't
  manufacture it with decorative boxes. (Real cards that group content are fine.)
- **No confidence score or risk dashboard.** A number invents precision the evidence lacks.
- **No uppercase prose, no heavy black rules, no flooded accent backgrounds, no decorative
  gradients, no glassmorphism.** Depth is one restrained soft shadow — never a hard drop shadow,
  neon, or blur-heavy glass.
- **No banned register** in copy: _strong proof, high confidence, all checks passed, safe to merge_
  — each substitutes the tool's verdict for the reviewer's. Write direct, concrete, testable claims.

---

Every token and component reduces to one rule: **show the reviewer the thing and its proof in the
same place, in plain language, and let them decide.**
