# Compact grouped port list — design

## Goal

Replace the simple-view card grid with a compact, RTL-friendly grouped list. The list must make it immediately clear which processes are running, where they listen, and whether attention is required — without the disconnected header metrics, orphaned cards, or unused desktop space shown in the current UI.

## Scope

- Applies only to the **simple** ports view.
- Keeps the existing advanced table view and all current process actions.
- Preserves the existing categories: user/development processes, applications/browsers, other services, and macOS system processes.

## Information architecture

Each category becomes one compact section:

1. **Section header** — category icon, title, active-process count, short aggregate resource summary, and a single expand/collapse control. These remain one logical RTL cluster; the chevron is the only item placed at the opposite edge.
2. **Process rows** — a stable scan order within the group:
   - primary: process/application name and port;
   - secondary: listening scope and source/path;
   - supporting metadata: PID, CPU, and RAM in aligned compact cells;
   - actions: details first, protected stop action second.
3. **State emphasis** — network-exposed listeners, elevated usage, and protected/system processes receive restrained semantic indicators. Ordinary rows stay quiet.

## Layout and spacing

- One visual container per category; rows are separated by dividers rather than nested cards.
- Desktop uses a single, full-width list per category to eliminate the third-column orphan problem. Narrow screens retain the same topology and wrap secondary metadata beneath the primary row.
- Introduce a local 4px-based spacing contract for simple view: 4 / 8 / 12 / 16 / 24px. Related content uses 8–12px; category-to-category separation uses 24px.
- No `space-between` across category title, metrics, and chevron. The title/count/resource summary use a single flex cluster.
- Rows preserve a 44px minimum target for interactive controls and have visible keyboard focus.

## Visual language

- Retain the project’s existing dark palette and semantic success/warning/danger colors.
- Reduce decorative pill/chrome density: port and security state remain compact badges; PID/resources become plain aligned metadata.
- Existing icon style and system font remain unchanged. Motion is limited to a short expand/collapse transition and respects reduced-motion preferences.

## Rendering and interaction

- Refactor the simple-mode renderer to emit one consistent grouped-list structure for every category, including system processes.
- Group headers stay collapsible and preserve the currently expanded state across refreshes where possible.
- Existing details, browser-open, and guarded stop handlers remain attached to their equivalent row controls.
- Empty groups are not rendered. Existing search and filters continue to determine the records shown in each group.

## Accessibility and RTL

- Keep Hebrew `dir="rtl"` ordering and ensure mixed Hebrew/English process names and paths do not reverse incorrectly.
- Use semantic buttons for expand/collapse with `aria-expanded` and linked group content IDs.
- All status color is paired with text/icon cues; contrast must meet the existing dark-surface requirements.

## Verification

1. Run the existing test suite and relevant UI safety tests.
2. Start the local UI and verify: zero/one/many groups, long process names and paths, exposed listener, system process, disabled stop action, search results, and both view modes.
3. Check desktop, tablet, and narrow mobile widths for no overflow or orphaned grid area.
4. Re-run Impeccable’s layout detector and verify the squint, rhythm, hierarchy, breathing-room, consistency, and responsive checks against the resulting selectors.

## Out of scope

- Changes to backend port discovery, risk policy, advanced table columns, cache view, or app-wide visual rebrand.
