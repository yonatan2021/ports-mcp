---
name: Port Manager
description: A calm, local-first macOS workspace for understanding ports and processes.
colors:
  app-dark: "#1e1e22"
  app-light: "#f2f2f7"
  ink-dark: "#f5f5f7"
  ink-light: "#1d1d1f"
  primary-dark: "#0a84ff"
  primary-light: "#007aff"
  success-dark: "#30d158"
  warning-dark: "#ffd60a"
  danger-dark: "#ff453a"
typography:
  headline:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Text, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Text, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, SF Pro Text, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
  mono:
    fontFamily: "JetBrains Mono, SF Mono, ui-monospace, Menlo, Monaco, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 500
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "14px"
spacing:
  compact: "4px"
  control: "8px"
  panel: "12px"
  workspace: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary-dark}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "26px"
  button-secondary:
    backgroundColor: "rgba(255, 255, 255, 0.07)"
    textColor: "{colors.ink-dark}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "26px"
  input-search:
    backgroundColor: "rgba(255, 255, 255, 0.07)"
    textColor: "{colors.ink-dark}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 42px 0 30px"
    height: "30px"
---

# Design System: Port Manager

## Overview

**Creative North Star: "The Calm Control Room"**

Port Manager is a task-dense, local-first macOS workspace. It should let a developer scan a live system state, find the relevant process, and take a guarded action without decorative friction. The shell is quiet and dark-first by default; contrast, grouping, and selected state do the hierarchy work.

The product should feel technically capable and familiar, never theatrical. The interface explicitly rejects web-dashboard ornament, a fake macOS desktop, neon console styling, iOS-style card piles, fake traffic lights, gradients, glow, and indiscriminate transparency. RTL content is a first-class layout direction, not a mirrored afterthought.

**Key Characteristics:**

- Compact, scan-first information density with one clear workspace focus.
- System typography for UI; monospaced values only where technical data benefits from alignment.
- Tonal layering and hairline separators before elevated surfaces.
- Semantic color communicates action and risk; blue is reserved for focus, selection, and primary action.
- State motion is brief, optional, and never hides content.

## Colors

The palette behaves like a restrained native utility: a charcoal or cool-light substrate, one Apple-blue action channel, and semantic colors that carry safety meaning rather than decoration.

### Primary

- **System Action Blue:** the `primary-dark` and `primary-light` frontmatter tokens drive the primary refresh/action control, keyboard focus, selected navigation icon, and selected rows. Keep this color scarce; it is a signal, not a surface theme.

### Secondary

- **Safe Green:** the `success-dark` token communicates a healthy, completed, or available state. It never substitutes for the primary action color.
- **Caution Yellow:** the `warning-dark` token marks protected, partial, or potentially consequential system state.
- **Guarded Red:** the `danger-dark` token is reserved for termination, trashing, and other destructive actions after explicit confirmation.

### Neutral

- **Control Room Charcoal:** `app-dark` is the default application ground; translucent white overlays create controls, selected surfaces, and subtle depth in dark mode.
- **Cool Utility Light:** `app-light` is the light-mode ground; white surfaces and restrained black translucency replace the dark overlay stack.
- **High-Legibility Ink:** `ink-dark` and `ink-light` are the default reading colors. Secondary and muted text must remain legible against their current surface.

**The One Signal Rule.** Use blue for primary action, current selection, and focus only. Do not add it as a decorative border, panel wash, or ubiquitous icon color.

## Typography

**Display Font:** Inter with the macOS system stack fallback.

**Body Font:** Inter with the macOS system stack fallback.

**Label/Mono Font:** JetBrains Mono with SF Mono and system monospace fallbacks.

**Character:** The type system is compact, plainspoken, and operational. One sans family establishes stable hierarchy; monospace is limited to ports, PIDs, resource values, commands, counts, and shortcuts where fixed-width scanning helps.

### Hierarchy

- **Headline** (650, 17px, 1.25): workspace titles and active-view context.
- **Title** (600, 13–15px, 1.25): panel headings, process names, and important labels.
- **Body** (400–500, 13px, 1.45): interface copy and routine controls.
- **Label** (600, 10–12px): table headers, section labels, and compact navigation metadata.
- **Mono** (500, 10–12px): live system data, identifiers, numeric metrics, command text, and counts.

**The Scanline Rule.** Never use display typography or fluid type scales in product UI. A developer must be able to compare labels and data at a glance.

## Elevation

Depth is primarily tonal: the sidebar, toolbar, control layer, selected row, divider, and inspector form a hierarchy through subtle contrast. Small shadows support floating elements; stronger shadows belong only to transient overlays such as dialogs, settings, and toasts. Native Electron shell regions deliberately avoid renderer blur for performance and data legibility.

### Shadow Vocabulary

- **Surface Hint** (`0 1px 3px rgba(0, 0, 0, 0.25)` in dark mode): limited support for compact contained surfaces.
- **Floating Feedback** (`0 4px 16px rgba(0, 0, 0, 0.35)` in dark mode): toasts and a hovered card where separation materially clarifies affordance.
- **Overlay Depth** (`0 12px 36px rgba(0, 0, 0, 0.5)` in dark mode): settings and confirmation overlays only.

**The Native Depth Rule.** Do not combine a decorative wide shadow with a visible 1px card border. Prefer tonal layering and separators; elevate only when a surface truly floats above the workspace.

## Components

### Buttons

Buttons are compact, rectangular controls with gently curved corners (6px radius) and a consistent 26px control height. Primary buttons use system blue with white text; secondary buttons use the control surface with a hairline border; destructive buttons use a restrained red tint and red text. Hover changes background and, for primary actions, adds only a tight blue shadow. Every button needs hover, `:focus-visible`, active, disabled, and busy behavior.

### Chips

Counts, filter tabs, and segmented controls are compact scan aids. Pills are allowed only for counts and tags; segmented choices use 4–7px corners. The active option gains the active surface and stronger text weight, not a bright decorative fill.

### Cards / Containers

Containers use 10px corners and thin translucent separators when they group a distinct task. The main port workspace favors edge-to-edge tables and split panes over a field of cards. Cards are appropriate for the optional simple view and cache groups, where a grouped list is the actual affordance.

### Inputs / Fields

Search and numeric fields sit on the control surface with a 1px subtle border and 6px corners. Focus shifts the border to primary blue and uses a 2px focus ring. Placeholder text must meet the same readability standard as body text.

### Navigation

The sidebar is a compact vertical command list with section labels, 30px rows, 15px icons, and one selected state. At narrower desktop widths, it collapses to the icon rail; at small widths, the inspector becomes an overlay rather than compressing table content beyond usefulness.

### Process Inspector

The inspector is progressive disclosure earned by a selected row. It uses a 280–340px secondary pane, hairline separation, key/value rows, a scrollable command block, and full-width guarded actions. It must never compete with the port table before a selection exists.

## Do's and Don'ts

### Do:

- **Do** keep Ports and Processes the dominant workspace; use tables, selection, separators, and a conditional inspector to make live state legible.
- **Do** use semantic green, yellow, and red only to communicate system status, safety, or consequence.
- **Do** preserve full keyboard access, visible focus, RTL/LTR behavior, selectable technical values, and reduced-motion fallbacks.
- **Do** keep routine transitions within the existing 140–220ms system; use motion only for state change, feedback, or a clearly triggered overlay.

### Don't:

- **Don't** make the app resemble a web dashboard, a fake macOS desktop, a neon developer console, or an iOS card-heavy app.
- **Don't** add gradients, glow, fake traffic lights, or indiscriminate transparency. Real Electron window capabilities take precedence over imitation.
- **Don't** use blue as decoration, or use non-semantic saturated colors on inactive surfaces.
- **Don't** turn every dataset into cards or make modal dialogs the first solution; prefer inline disclosure and split-pane inspection.
- **Don't** hide content behind entrance motion, or rely on color alone to communicate a safety state.
