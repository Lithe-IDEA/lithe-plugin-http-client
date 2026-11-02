# Changelog

## 0.1.2 — 2026-11-02 (preview)

- Open UTF-8 `.http` / `.rest` files, select requests and navigate to their source lines without sending automatically.
- Add CodeMirror highlighting, line numbers, undo, viewport rendering and single-line placeholder/caret behavior.
- Keep bounded, clearable request history in the page session without persisting drafts or credentials.
- Refine compact light/dark layouts, draggable/keyboard split panes, narrow-window stacking and operation feedback.
- Default the body preview to 128 KiB and allow 1–512 KiB in 1 KiB steps.
- Improve header typography and contrast; toggle body wrapping/horizontal scrolling; collapse leading HTML blank lines with a raw-view toggle.
- Export original bodies or headers plus body through native save dialogs, preserving raw content and explicit truncation notices.
- Save HTML into the current local workspace and request its native editor preview; require backend 2 and workspace metadata, document-summary and preview permissions.
- Use the minimal globe icon with host-controlled sidebar selection tint and theme-aware panel coloring.
- Bundle UI dependencies and license records locally; verify protocol and real backend browser workflows in CI.
- Universal macOS package; full native file-dialog/editor-preview and Intel hardware acceptance remain pending. Windows remains unsupported.

## 0.1.1 — 2026-11-02 (preview)

- Remove the duplicate HTTP Client title inside the native tool window.
- Highlight header keys, separate values and collapse long values until expanded.
- Configure body preview size in the panel: 48 / 256 / 512 KiB, default 512 KiB. Preserve Unicode and account for JSON escaping within the host transport budget.
- Hide JSON formatting and body truncation notices while viewing headers.
- Declare and package a dedicated theme-tinted HTTP tool-window icon.
- Marketplace installation progress is host-owned and is tracked separately from this plugin release.

## 0.1.0 — 2026-11-02 (preview)

- Independent HTTP Client tool window, preserving the native Lithe workbench.
- Paste and parse multiple `.http` requests, choose and send with inline variables, headers and bodies.
- Cancel in-flight requests; enforce a 30-second timeout and bounded input/response previews.
- Split request/response layout, body/header views, optional JSON formatting, status/time/size, keyboard send, Chinese/English and host theme support.
- Explicit errors for unsupported local file includes, response scripts and redirects.
- Universal macOS package with pinned upstream dependencies, bundled license notices and SHA-256.
- Real SDK protocol and Core bridge tests passed. Native installation/window acceptance remains pending because the available UI automation could not operate Lithe's plugin settings menu. Intel code is cross-built; Intel hardware acceptance remains pending. Windows is unsupported.
