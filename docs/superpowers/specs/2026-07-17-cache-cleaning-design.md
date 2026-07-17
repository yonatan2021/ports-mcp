# Cache Cleaning System Design

This document details the architecture, safety parameters, API routes, MCP tools, and UI design for the macOS Cache Cleaning feature in `ports-mcp`.

## Goal

Provide non-technical and AI-assisted developers with a safe, efficient, and visual way to manage, scan, and clean local development and system caches (e.g., npm cache, `.next/cache`, Vite cache) without risking data loss or system destabilization.

---

## Safety & Categorization

To maintain the highest caution ("זהירות מירבית"), all detected cache locations are classified into distinct safety levels.

### 1. Safety Classifications

*   **`SAFE_TO_CLEAR`**
    *   *Definition:* Development-related caches that automatically rebuild when needed. Clearing them has no impact on other running applications.
    *   *Locations:*
        *   Global package managers: `~/.npm`, `~/Library/Caches/yarn`, `~/Library/Caches/pnpm`, `~/.bun/install/cache`.
        *   Local project build directories (within the workspace): `.next/cache`, `node_modules/.cache`, `.vite`.
    *   *UI Treatment:* Green label/badge. Enabled by default for batch cleaning.
*   **`NEEDS_CONFIRMATION`**
    *   *Definition:* User application caches (e.g., Google Chrome, Slack, VS Code). Clearing them might disrupt active sessions or require applications to be restarted.
    *   *Locations:* Folders under `~/Library/Caches` that correspond to active apps.
    *   *UI Treatment:* Orange/Amber label/badge. Requires individual user confirmation before deletion.
*   **`SYSTEM_PROTECTED`**
    *   *Definition:* macOS system cache folders or folders owned by other users.
    *   *UI Treatment:* Muted gray badge. Deletion is disabled (🔒) at the safety layer.

### 2. Trashing Mechanism (No Permanent Deletion)

Instead of running destructive `rm -rf` commands directly:
*   **Electron App Mode:** Uses `shell.trashItem(path)` to asynchronously move folders to the macOS Trash.
*   **CLI / HTTP Server Mode:** Executes an AppleScript wrapper to safely delegate trashing to the macOS Finder:
    ```bash
    osascript -e 'tell application "Finder" to delete POSIX file "/path/to/folder"'
    ```
    This ensures users can always restore any cleared cache from their Trash bin if needed.

### 3. Path Validation Guardrails

Before trashing any directory, the safety layer (`src/safety.js`) enforces:
1.  **Ownership Check:** The target path must be owned by the current macOS user.
2.  **Location Constraints:** The path must reside within the user's home folder (`~/`) and match recognized cache folder patterns.
3.  **Active Process Lock:** Check if any active process listed by `ports-mcp` is currently bound to a port within the directory being deleted.

---

## API Design

Two new endpoints will be registered in `src/http-server.js`:

### 1. `GET /api/system/cache`
Scans global and workspace paths for cache folders.
*   **Response Structure:**
    ```json
    {
      "items": [
        {
          "name": "npm Cache",
          "path": "/Users/username/.npm",
          "bytes": 858993459,
          "category": "SAFE_TO_CLEAR",
          "description": "npm package manager download cache"
        },
        {
          "name": "Next.js Cache",
          "path": "/Users/username/projects/app/.next/cache",
          "bytes": 104857600,
          "category": "SAFE_TO_CLEAR",
          "description": "Local Next.js project build cache"
        }
      ]
    }
    ```

### 2. `POST /api/system/cache/trash`
Trashes a target directory path.
*   **Payload:**
    ```json
    {
      "path": "/Users/username/.npm",
      "confirm": true
    }
    ```
*   **Response:**
    ```json
    {
      "ok": true,
      "path": "/Users/username/.npm",
      "trashed": true
    }
    ```

---

## MCP Tools

Two new stdio tools will be added to `src/mcp-tools.js` / `src/mcp-server.js`:

1.  **`list_caches`**
    *   Lists cache directories, their size in bytes, safety level, and description.
2.  **`clean_cache`**
    *   Moves a specific cache directory to the system trash.
    *   *Parameters:* `path` (string, required), `confirm` (boolean, required).

---

## UI/UX Design

Integrated into the existing glassmorphic "Storage and Temporary Files" panel (`public/index.html`):

1.  **Visual Layout:**
    *   Interactive items list replacing the static list.
    *   Each entry shows name, size, safety badge, description, and an SVG Action Button (🗑️ or 🔒).
2.  **Accessible Elements (WCAG AA):**
    *   Interactive touch targets padded to minimum `44x44px`.
    *   Focus indicator ring on tab selection.
    *   Explicit `aria-label` tags for all action triggers.
3.  **UI Feedback:**
    *   **Skeleton Loaders:** Prevents layout shift during scanning.
    *   **Scale/Micro-interactions:** Buttons scale on press (`transform: scale(0.98)`).
    *   **Quick Clean:** A master button to clear all `SAFE_TO_CLEAR` items simultaneously.

---

## Verification Plan

### Automated Verification
*   Unit tests in `test/storage-tools.test.js` validating:
    *   Cache classification matching.
    *   Trashing command generation (mocking AppleScript & Electron shell).
    *   Safety rules (blocking invalid/system paths).

### Manual Verification
*   Deploy to local browser interface and verify:
    *   Correct sizing calculations.
    *   Item is correctly sent to macOS Trash (Finder verification).
    *   Confirm modals prompt user before action.
