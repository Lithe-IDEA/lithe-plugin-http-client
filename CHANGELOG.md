# Changelog

## 0.1.0 — 2026-11-02 (preview)

- Independent HTTP Client tool window, preserving the native Lithe workbench.
- Paste and parse multiple `.http` requests, choose and send with inline variables, headers and bodies.
- Cancel in-flight requests; enforce a 30-second timeout and bounded input/response previews.
- Split request/response layout, body/header views, optional JSON formatting, status/time/size, keyboard send, Chinese/English and host theme support.
- Explicit errors for unsupported local file includes, response scripts and redirects.
- Universal macOS package with pinned upstream dependencies, bundled license notices and SHA-256.
- Real SDK protocol and Core bridge tests passed. Native installation/window acceptance remains pending because the available UI automation could not operate Lithe's plugin settings menu. Intel code is cross-built; Intel hardware acceptance remains pending. Windows is unsupported.
