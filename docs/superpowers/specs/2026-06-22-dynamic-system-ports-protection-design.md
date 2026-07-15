# Design Spec: Dynamic System Process Protection

## Goal
Improve the security and usability of the Port Manager application by dynamically classifying system processes on macOS instead of using a rigid, hardcoded port threshold (`<= 1024`). By default, the application should run in `blocklist` mode, allowing developers to safely terminate their own custom processes (even if they run on low ports like port 80) while preventing the termination of crucial system processes (even if they run on high ports like port 7000).

## Requirements
1. **Dynamic Classification**:
   - Classify a process as a system process (`isSystem: true`) if:
     - The process owner is a system user (e.g. `root` or starts with `_`).
     - The executable command path resides in system folders (e.g. starting with `/System/`, `/usr/libexec/`, `/usr/sbin/`).
     - The process name matches a blocklist of critical operating system processes.
   - Otherwise, the process is a user process (`isSystem: false`).
2. **Backend Protection**:
   - The safety layer (`SafetyLayer`) must block any destructive actions on processes flagged as `isSystem === true`.
3. **Frontend Integration**:
   - The UI must disable the Terminate button for any process classified as `isSystem === true` or when the app is in `read-only` mode.
   - The UI filter tabs and metrics should be based on this dynamic classification (`isSystem`) rather than port ranges.
4. **Default Mode**:
   - Change the default security mode from `read-only` to `blocklist` so that user processes can be killed out-of-the-box.

## Proposed Changes

### Configuration Update (`src/config.js`)
- Update `DEFAULTS.mode` to `'blocklist'` so the application starts up in `blocklist` mode.
- Keep system ports in `DEFAULTS.blocklist` but rely primarily on the dynamic classification.

### Port Service Update (`src/port-service.js`)
- Define `isSystemProcess(portObj)` helper.
- Update `listPorts()` to enrich each returned port object with the computed `isSystem` boolean flag.

### Safety Layer Update (`src/safety.js`)
- In `checkDestructive()`, check if `target.isSystem === true`. If so, return `ok: false` with check: `'system_process'` and a descriptive reason.

### Frontend Updates
- **`public/index.html`**:
  - Update headings, sub-labels, and tooltips in Hebrew to refer to "system processes" and "user processes" instead of hardcoded numbers like "1024 and below".
- **`public/app.js`**:
  - Update `killDisabled` calculation to use `portObj.isSystem` instead of `isSystemPort`.
  - Update the metric counters and filter tabs to use `portObj.isSystem`.
  - Update Hebrew labels/tooltips.

## Verification & Testing
- Add unit tests verifying `isSystemProcess` classification on various mock inputs.
- Add unit tests verifying `SafetyLayer` blocks termination of processes flagged as `isSystem: true`.
- Run existing test suite to ensure no regressions.
