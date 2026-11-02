# HTTP Client for Lithe

**0.1.0 preview:** protocol/Core integration is verified; native install/window and Intel hardware acceptance are still pending.

A small HTTP workbench inside Lithe's native macOS tool window. Paste `.http` requests, select one, send it, and inspect the response without leaving the IDE.

## Install and use

Install **HTTP Client** from the Lithe plugin marketplace when its listing is available, or download the ZIP from [Releases](https://github.com/Lithe-IDEA/lithe-plugin-http-client/releases) and use Lithe's install-from-disk action. The universal macOS package contains Apple Silicon and Intel code. The host must advertise `backend: 1`, `serverProcess: 1`, and `ui: 2` (plugin API 3). Windows is not supported in this release.

Open the **HTTP Client** bottom tool window. Paste a request, then click **Send** (⌘/Ctrl+Enter). For multiple requests, use **Read requests**, choose an entry, then send. Editing the text invalidates the selection; sending reparses and selects the first request. No network request runs automatically.

```http
@base = http://localhost:8080
### Health
GET {{base}}/health
Accept: application/json

### Create item
POST {{base}}/items
Content-Type: application/json

{"name":"example"}
```

Replace the address with a service you intend to call. The UI follows the host's theme and language (English / Chinese), displays status, elapsed time and received size, and switches between body and headers. JSON formatting is optional. Select response text and use the normal copy shortcut. Responses are displayed as text; returned HTML is never executed.

## Scope and data handling

- The declared executable `bin/lithe-http-client` runs locally via the official Lithe plugin SDK. It performs HTTP(S) requests explicitly requested by the user. The Web UI only talks to the host bridge.
- No request history, draft persistence or automatic workspace/file reads. Request text, headers and response content stay in memory; closing/recreating the page can discard them. The plugin does not write to its package or application bundle.
- Inline `@variables`, headers, request bodies and `###` separators use the unchanged OpenIDEA parser/executor. Environment files, local body includes, response scripts and file redirects are unsupported. Includes and scripts/redirects fail explicitly before sending.
- 128 KiB input, 30-second overall request timeout, cancellable operations, 48 KiB text preview. Upstream retains at most 16 MiB of network body. Received size can exceed the preview size; truncation is visible. Binary responses show status/headers without a body preview.
- Network/prepare errors are localized stable codes; raw request URLs and transport errors are not exposed in diagnostics. User-supplied text and server responses can contain secrets; this is a local HTTP client, not a redaction tool.
- Uses upstream default proxy behavior; Lithe's proxy settings are not synchronized. No custom TLS/credential/environment UI.
- macOS host chrome remains native; the plugin content is a themed Web page. This is not a replacement for the editor or a new host architecture.
- Community package with ad-hoc executable signature, not publisher-signed or notarized. Lithe handles program review/consent on install.

## Build and verify

Requires macOS, Python 3, Rust (edition 2024), Xcode command line tools, and the `x86_64-apple-darwin` Rust target. Pinning uses Cargo.lock and Git revisions; no runtime downloads.

```sh
cargo build --release --locked
cargo build --release --locked --target x86_64-apple-darwin
cargo fmt --check
cargo clippy --locked -- -D warnings
python3 scripts/package.py
python3 scripts/test_protocol.py --binary dist/io.github.lithe-idea.http-client/bin/lithe-http-client
```

Use a consistent rustup `cargo`/`rustc` toolchain on PATH when cross-compiling. Packaging uses `lipo`, validates both architectures, signs the executable ad-hoc, checks its signature, includes dependency notices and creates `dist/http-client-0.1.0-darwin.zip` with one plugin-ID parent directory and a SHA-256 sidecar. Published release assets are immutable: fixes require a new version.

Protocol integration tests use real SDK processes and a loopback HTTP server, with bounded waits and cleanup. Individual timings and failures are emitted to `.artifacts/test-stability/index.html` and `junit.xml`.

Optional real Core integration (requires a compatible host Core library):

```sh
python3 scripts/test_core.py --core /path/to/liblithe_core.dylib --binary dist/io.github.lithe-idea.http-client/bin/lithe-http-client
```

Run that C ABI integration under an external 30-second process watchdog. `scripts/test_ui.js` is a browser test function for the loaded `ui/index.html`; its mocked bridge checks interaction state, cancellation and text-only rendering. Mocked UI tests do not replace native host acceptance.

## Architecture and attribution

The native Lithe host owns installation, activation, Web bridge, process lifecycle and cancellation. This plugin owns its UI and a thin Rust function adapter. HTTP parsing, variable resolution and transport come from unchanged `ide-http` / `ide-core` in [OpenIDEA](https://github.com/l0ng-ai/openidea), revision `3be40bd57c5718df39977c5f8b5d31f0ff3e692a` (Apache-2.0). The [official Rust SDK](https://github.com/Lithe-IDEA/lithe-plugin-docs) is pinned at `e689971c000c15a044df0502052fe7b2c1c6f84f` (MIT).

This project's adapter and UI are Apache-2.0. Release packages retain original dependency license/notice texts and include `DEPENDENCIES.json` and `UPSTREAM.json`. Missing crate-distribution license files are supplemented from pinned upstream sources recorded in `licenses/SOURCES.json`. Upstream authors do not endorse this plugin.

## 中文说明

保留 Lithe 原生 Mac 工作台，在底部工具窗口提供独立 HTTP 面板。粘贴 `.http` 文本后可发送请求、取消、查看状态码／耗时／大小，切换正文与响应头，格式化 JSON。界面跟随宿主中英文和主题。首版仅支持 macOS；没有环境文件、文件引用、响应脚本、历史记录或编辑器行内按钮，不会自动保存含有令牌的请求。
