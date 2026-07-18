# First workspace screen — design

## Goal

Make the ports screen feel like a calm daily-use tool: a person should see the running-process list and find a process within one screen on desktop and narrow mobile, without changing port discovery, safety policy, or destructive-action safeguards.

## Scope

- Applies to the ports workspace only.
- Keeps the existing simple grouped list as the default process presentation and keeps the advanced table available.
- Retains the existing Cache destination, safety settings, confirmations, filtering behavior, search behavior, and port-release flow.
- Does not alter server APIs, process classification, permission policy, or Cache layouts.

## Information architecture

### Header

The header contains product identity, a compact connection/safety indicator, refresh, the existing safety-settings entry point, and a compact focus-mode control. It has no global-search field. On narrow screens, controls wrap into one full-width, touch-safe action row without horizontal clipping.

### Ports workspace

The page starts with the workspace title, result count, and one primary search field. This keeps the existing search capability but removes the duplicate global field. A single compact filter row follows: all processes, my applications, and macOS. The simple/advanced view selector remains available but is visually secondary to the search and filters.

The process list directly follows these controls. Existing system metrics are retained as a compact status strip that does not dominate the first screen. Education, history, and other secondary surfaces stay available but are not placed ahead of the list. Focus mode remains a persisted, compact control that hides the metrics, education, and history; it does not change data behavior or safety rules.

### Contextual port release

The release-port form is hidden by default. The existing quick action is retained as its explicit trigger, but the redundant quick-search action is removed. A numeric port search may also reveal the form. Once open, it retains the current input validation, safety checks, confirmation behavior, and feedback. Search chips are removed from the primary workspace because they compete with the single search affordance.

## Layout and visual rules

- Use the existing dark palette, system font, semantic colors, and RTL document direction.
- Use a 4/8px spacing rhythm with 16px section padding and 24px separation between major regions.
- Keep body text at 16px on narrow screens; supporting text may be 14px only where contrast remains clear.
- Every interactive control in the primary mobile flow is at least 44px high, with at least 8px between neighboring touch targets.
- Do not add emoji as structural navigation or action icons. Existing structural emojis are replaced with matching inline SVG icons where that does not change the action behavior; existing process-category signals can remain textual until separately redesigned.
- Prefer dividers and hierarchy over extra cards, shadows, pills, and instructional copy.
- All focus styles remain visible; reduced-motion behavior remains unchanged.

## Interaction and state

- The primary ports search synchronizes with the existing filtering state. Removing the global-search input must not remove ports-search behavior or Cache-search behavior.
- Numeric searches expose the release affordance without opening it automatically or running any action.
- The advanced table remains user-selectable and preserves its current process actions and safety restrictions. The existing focus-mode persistence and accessibility announcements also remain intact.
- Existing destructive actions still require their current confirmation gates. The redesign only changes their placement, not permission or confirmation logic.
- No page reload, data fetch, or process operation is introduced by opening/closing the release form.

## Accessibility and responsive behavior

- Header and workspace content must fit a 375px viewport with no horizontal document overflow.
- The process list must begin within the initial 812px mobile viewport after the header/navigation; the controls must not create a large blank region.
- Buttons use semantic `button` elements and descriptive accessible names. The view selector keeps its radio semantics and checked state.
- Search has a visible label or an equivalent accessible name; error/success feedback continues to use the existing live region.
- Color remains supplementary to explicit status text/icon cues.

## Verification

1. Add static UI regression tests for the removed global search/chips, compact header contract, contextual release surface, 44px mobile controls, and existing safety controls.
2. Run the full Node test suite.
3. Start the local UI and inspect the ports screen at 1280px and 375px widths: no horizontal overflow, list visible above the fold, one search field, release form hidden before context, numeric-search affordance visible, and both list/table modes usable.
4. Confirm keyboard focus, reduced motion, RTL mixed-direction process values, and the current destructive confirmation path.

## Out of scope

- New backend endpoints or changes to port scanning.
- New permissions, changes to safety settings, or weaker confirmation requirements.
- A full navigation redesign, new design-system dependency, or Cache-view redesign.
