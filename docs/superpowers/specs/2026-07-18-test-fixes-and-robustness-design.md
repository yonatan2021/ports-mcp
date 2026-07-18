# Design Specification: Test Fixes and Comprehensive Robustness Suite

Date: 2026-07-18
Topic: Fixing failing tests and establishing a comprehensive integration/robustness test suite.

## Problem Description
1. **Mock mismatch in `test/port-service.test.js`**:
   The test mock for `execFile` expected a single PID argument (`'12345'`), but the port-service implementation batches PID queries by joining them with commas (e.g. `'12345,22222,33333'`). This causes the mock to return empty working directories and fails assertions.
2. **Ignored du failure in `src/port-service.js`**:
   `getSizesForPaths` swallowed errors when `du` failed and cached `0` bytes for all files. Callers like `getCacheDetails` then filtered out any item with `bytes <= 0`. As a result, the items were excluded from the results instead of being returned with `bytes: 0` as expected by `test/storage-tools.test.js`.
3. **Need for comprehensive robustness tests**:
   Ensure system resilience against system utility failures (e.g., `lsof` or `ps` failing), input boundary validation errors, safety mode enforcement, and rate-limiting limits.

---

## Proposed Changes

### 1. Fix Mock Mismatch in `test/port-service.test.js`
* **Change**: Update the `runner.execFile` stub in `port-service.test.js`.
* **Logic**: Check if the PID argument contains `12345` (by splitting on commas) rather than an exact match.
  ```javascript
  if (args[2] && args[2].split(',').includes('12345')) { ... }
  ```

### 2. Fix Error Propagation in `src/port-service.js`
* **Change**: Remove the internal `try-catch` block from `getSizesForPaths` (or rethrow).
* **Logic**: If the `du` command execution throws an error, let it propagate to `getCacheDetails`. `getCacheDetails` already has a catch block that maps all items to `bytes: 0` without filtering them.

### 3. Create Comprehensive Robustness Test Suite
* **File**: `test/comprehensive-robustness.test.js`
* **Test cases**:
  * **System Command Resiliency**: Mock `execFile` to throw or return invalid outputs for `lsof`, `ps`, and `du` and assert that the service degrades gracefully (e.g. returns empty collections, placeholder names, or safe defaults rather than throwing unhandled exceptions).
  * **API Parameter Validation**: Assert that the HTTP API endpoints (`/api/ports/:port`, `/api/ports/kill`, `/api/system/suspend`, etc.) return structured `400 Bad Request` errors with `safe_hint` when provided with invalid inputs (e.g., non-numeric ports, negative PIDs, invalid JSON payloads).
  * **Safety Enforcement & Mode Switching**: Verify transitions between `read-only`, `allowlist`, and `blocklist` modes via the safety API. Assert that write/destructive actions are blocked appropriately under each mode.
  * **Rate Limiting Simulation**: Assert that sending rapid consecutive request bursts behaves correctly with the rate-limiting middleware, returning warning details or rate limit statuses.

---

## Verification Plan

### Automated Tests
- Run all unit and integration tests:
  ```bash
  node --test
  ```
- Run the new robustness suite specifically:
  ```bash
  node --test test/comprehensive-robustness.test.js
  ```
