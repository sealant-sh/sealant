# Design System Specification: Sealant App (Swiss-Tech Neon)

## 1. Overview & Creative North Star

**The Sealant App** is a high-performance design system for sandboxed development environments. It rejects standard SaaS "softness" in favor of aggressive Swiss grid structures, high-contrast typography, and a "neon-on-black" aesthetic that mirrors terminal environments and precision engineering.

### Design Principles:

- **Swiss Precision:** Strict adherence to a 12-column grid and modular spacing.
- **Aggressive Typography:** Over-scaled headlines and tight tracking to create visual impact.
- **Kinetic Feedback:** Every interaction should feel mechanical and immediate.
- **Data as Art:** System metrics and logs are treated as core visual elements, not hidden details.

---

## 2. Visual Foundation

### Color Palette

- **Primary (Electric Magenta):** `#fa68ff` (Used for CTAs, active states, and primary branding).
- **Secondary (Cyan Pulse):** `#00effa` (Used for progress bars, secondary data points, and terminal accents).
- **Background (Abyss):** `#0e0e0e` / `#131313` (Deep, non-pure blacks to provide depth).
- **Surface (Steel):** `#353534` (Used for borders, dividers, and container backgrounds).
- **Text:** White (`#ffffff`) for high readability, 60% opacity for secondary labels.

### Typography

- **Primary Font:** `Inter` (Black or ExtraBold weight for headlines).
- **Monospace Font:** `Space Grotesk` or standard `monospace` (For logs, metrics, and terminal data).
- **Style:** Uppercase headlines, tight tracking (-0.05em), and aggressive sizing (48px+ for hero titles).

---

## 3. Core Components

### TopAppBar (SEALANT_APP)

- **Structure:** Fixed top, height 80px.
- **Elements:** Branding logo (uppercase, wide tracking), System Status indicator (right-aligned), and a grid toggle icon.
- **Styling:** `#131313` background with a solid `#353534` bottom border.

### BottomNavBar

- **Structure:** Fixed bottom, height 64px.
- **Icons:** Minimal line-art icons for Logs, Layers, Stats, and Config.
- **Active State:** Solid `#fa68ff` background with `#131313` icon.
- **Inactive State:** Low-opacity white.

### Data Cards (Container Items)

- **Styling:** `#131313` background, 1px border `#353534`.
- **Metrics:** Labels in 60% opacity text; values in high-contrast white or neon cyan.
- **Progress Bars:** Solid bars with neon fills (Cyan for usage, Magenta for warnings).

### Interactive Elements

- **Primary Buttons:** Solid `#fa68ff` with black uppercase text. No border-radius.
- **Secondary Buttons:** Transparent background with 1px white border.
- **Toggles/Switches:** Rectangular, high-contrast state changes (Magenta for ON).

---

## 4. Key User Flows & Screen Specs

### 1. Marketing Landing Page

- **Hero:** Oversized "VOID ISOLATION ENGINES" text.
- **Feature Grid:** 4-column layout on desktop, single column on mobile.
- **Conversion:** Stark magenta footer with "GET_STARTED" call to action.

### 2. Container Dashboard

- **State Management:** List of active/stopped containers.
- **Visuals:** Each container card shows real-time RAM/CPU bars in `#00effa`.
- **Action:** "INSPECT INSTANCE" button leads to terminal.

### 3. Terminal & Logs

- **Header:** Big "NODE_REACTIVE_01" process identifier.
- **Terminal Area:** Dark grey background box with scrolling monospaced text.
- **Color Coding:**
  - `LOG`: Cyan
  - `WARN`: Yellow/Magenta
  - `ERROR`: Bright Magenta
  - `SYSTEM`: White

### 4. Sandbox Configuration

- **Control:** Range sliders for Resource Allocation.
- **Layout:** Vertical stack of parameters with individual "Commit Changes" footer.

---

## 5. Layout & Spacing

- **Base Unit:** 4px grid.
- **Margins:** 32px (8 units) for mobile edges.
- **Gutters:** 16px between grid items.
- **Radius:** 0px (Absolute hard edges).
