# Release Notes — Version 1.2.0

`ports-mcp` 1.2.0 refines the local macOS workspace around faster project triage,
safer process decisions, and a more focused cache-cleaning experience.

## Highlights

### Project-first ports workspace

- Added adaptive filters for detected projects, development servers, externally
  reachable services, and processes that merit review.
- Added a keyboard-accessible process inspector with port, PID, listener scope,
  command, full-details, and guarded termination controls.
- Improved grouped port results, selection state, and compact table scanning.

### Activity Monitor improvements

- Added dynamic CPU, memory, energy, and storage filters based on the processes
  currently running on the Mac.
- Refined system-monitoring views so user processes and protected macOS processes
  are easier to distinguish.

### Cache-cleaning workflow

- Redesigned the cache workspace with scan summaries, safety guidance, size and
  text filters, and grouped results.
- Kept cleanup guarded: only backend-approved caches can be selected, and actual
  cleanup still moves items to the macOS Trash after confirmation.

### Safety and reliability

- Collapsed the default system-port protection range into one summary in Settings,
  rather than rendering 1,024 individual controls. Custom blocked ports remain
  individually manageable.
- Updated indirect runtime dependencies to remove the known security advisories
  reported by `npm audit` at release preparation time.

## Upgrade notes

Install the locked dependencies and run the test suite:

```bash
npm ci
npm test
```

For a desktop build, run:

```bash
npm run package:mac -- --arm64 --x64 --publish never
```

This document prepares version 1.2.0 only. Publishing the Git tag and GitHub
Release remains a separate, deliberate step.
