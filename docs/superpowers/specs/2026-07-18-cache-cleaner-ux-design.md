# Cache cleaner UX design

## Goal

Make the Cache Cleaner understandable and safe for people who do not work with development tools. The page must replace the current unbounded list with a calm summary, progressively disclosed groups, plain-language explanations, and a deliberate cleanup flow.

## User outcome

A user can answer three questions before cleaning anything:

1. What is a cache and what will happen if it is cleaned?
2. Which items are safe to clean automatically?
3. What will be moved to Trash and how much space can it free?

The user can then clean only items the backend labels `SAFE_TO_CLEAR`. The UI must never include `NEEDS_CONFIRMATION` or `SYSTEM_PROTECTED` items in the quick-clean action.

## Information architecture

### Overview panel

The Cache tab opens with an overview panel rather than a list. It contains:

- A plain-language heading and one-sentence explanation: cache is temporary data that apps can rebuild; it is not personal files or documents.
- The total scanned Cache size and a prominent "safe to clean" total.
- A reassuring safety note: cleanup moves files to macOS Trash; it does not permanently delete them.
- A primary `ניקוי בטוח` action, enabled only when one or more `SAFE_TO_CLEAR` items exist.
- A secondary `סריקה מחדש` action.

### Safety groups

All three safety groups are collapsed by default, including the safe group, to keep the first view short:

| Group | Source category | Default | Action |
| --- | --- | --- | --- |
| מומלץ לניקוי | `SAFE_TO_CLEAR` | Collapsed | Included in safe cleanup and can be cleaned individually |
| כדאי לבדוק לפני ניקוי | `NEEDS_CONFIRMATION` | Collapsed | Individual cleanup only, after a warning and explicit confirmation |
| מוגן ולא ניתן לניקוי | `SYSTEM_PROTECTED` | Collapsed | No cleanup action |

Each accordion header shows the item count, total size, a safety icon, and a short explanation. It uses a native button with `aria-expanded` and an associated region so that keyboard and screen-reader users receive the same state and context.

### Cache item detail

An open group presents compact cards rather than dense rows. Every card shows:

- Friendly name and size.
- One plain-language "what is this?" description.
- A safety explanation that matches its group.
- A collapsed "פרטים טכניים" section with the raw path for users who need it.
- A context-appropriate action: `העבר לפח` for eligible items or a disabled protected state.

## Safe-clean wizard

Clicking `ניקוי בטוח` opens a focused three-step dialog.

1. **What will happen** — explains that only backend-classified `SAFE_TO_CLEAR` items are included and that apps may rebuild their temporary files on next launch.
2. **Review** — lists the exact eligible items, item count, and total reclaimable size.
3. **Confirm** — repeats that the items move to Trash, not permanent deletion, and provides the final cleanup button.

The dialog has a visible progress indicator, Back and Cancel controls, keyboard focus management, Escape-to-close behavior, and a success state that reports how much was moved. On success, the page rescans and returns focus to the overview action.

## Safety rules and data flow

- The server remains the authority for safety classification; the client never infers or upgrades a category.
- Quick clean derives its list exclusively from the currently scanned `SAFE_TO_CLEAR` items, regardless of search or display filters.
- Individual cleanup uses the existing guarded Trash API and retains confirmation for `NEEDS_CONFIRMATION` items.
- `SYSTEM_PROTECTED` items are visually explainable but not actionable.
- Empty, loading, scan-error, and no-safe-items states provide a direct next step and never leave an empty visual gap.

## Visual and responsive direction

- Preserve the existing dark visual language, but use distinct mint, amber, and neutral safety surfaces with text labels; color alone must not encode safety.
- Use generous vertical spacing, a constrained content width, and collapsed groups to eliminate the continuous-scroll feeling.
- On small screens, summary metrics stack and accordion headers keep labels and totals readable; wizard controls remain reachable without horizontal scrolling.
- Buttons, disclosures, and inputs retain visible focus states and meet a minimum 44px touch target.

## Testing

- Add UI-level coverage for the three accordion categories, their collapsed initial state, accessible disclosure markup, and quick-clean selection restricted to `SAFE_TO_CLEAR`.
- Add coverage for the wizard’s review data and confirmation wording about Trash.
- Preserve the existing API safety tests: protected items cannot be trashed and all cleanup continues through the guarded endpoint.

## Non-goals

- No automatic cleanup on page load or on a timer.
- No permanent deletion from this interface.
- No change to backend classification policy in this UX scope.
