# Changelog

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
