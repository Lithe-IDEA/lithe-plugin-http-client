# HTTP Client for Lithe

**0.1.2 preview:** request editing, session history, response exports and a compact UI. Chrome/WebKit and protocol checks pass; native file-dialog/editor-preview and Intel hardware acceptance remain pending.

A compact HTTP workbench inside Lithe's native macOS tool window. Paste `.http` requests, select one, send it, and inspect the response without leaving the IDE.

## Install and use

Install **HTTP Client** from the Lithe plugin marketplace when its listing is available, or download the ZIP from [Releases](https://github.com/Lithe-IDEA/lithe-plugin-http-client/releases) and use Lithe's install-from-disk action. The universal macOS package contains Apple Silicon and Intel code. This version requires `backend: 2`, `serverProcess: 1`, and `ui: 2` (plugin API 3), adding workspace metadata, document-summary and preview permissions for HTML preview. Windows is not supported in this release.

Open the **HTTP Client** bottom tool window. Use **Open .http** to choose a UTF-8 `.http` or `.rest` file (up to 128 KiB), or paste a request. Files are read and their requests listed immediately. Choose an entry and click **Send** (⌘/Ctrl+Enter). **Read requests** reparses pasted text. Editing invalidates the selection; sending reparses and selects the first request. Choosing a file, request or history entry never sends it automatically.

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

Replace the address with a service you intend to call. The request editor provides HTTP / inline-variable / JSON highlighting, line numbers and undo. The divider is draggable (arrow keys also resize it; double-click resets it). Narrow windows stack the panes. The UI follows the host's theme and language (English / Chinese), displays status, elapsed time and received size, and switches between body and headers. JSON formatting is optional. Header names and values are separated; values start on one line and expand on click. The toolbar preview limit applies to the next send and is kept only for the current page session. JSON-escaped responses may be truncated earlier to fit the 900 KiB transport budget. Select response text and use the normal copy shortcut. The wrap icon switches between wrapped lines and horizontal scrolling. Request/response editors use CodeMirror's viewport rendering. Responses stay text in the plugin page.

The history selector keeps up to 20 sent requests / 1 MiB of source text in the current page session. It restores the source and selected request without sending; use the clear icon to discard it. No history or draft is persisted.

The workbench uses theme-aware inset editor panels, compact segmented response tabs, colored method/status badges, header/history counts, and response content-type metadata. Empty, loading and failed states explain the current operation without replacing real response content. Cancel appears while an operation is active; keyboard hints follow the host platform. Narrow and short docked panels retain the same controls, and reduced-motion preferences disable animation.

The tool-window icon, panel identity and empty state reuse the minimal globe in `assets/http.svg`. The host tints the template icon for inactive and selected sidebar states; the panel uses an accent color in light mode and a light neutral color in dark mode. The empty request editor uses a single-line example and CodeMirror's cursor/selection rendering, keeping the caret at one line in WebKit as well as Chromium.

Response headers use the host's proportional UI font and text size, with compact rows and readable name/value contrast. Code bodies keep the editor's monospace font. Long header names show their full name on hover; values expand on click.

The bottom-right save action opens the host's native save dialog and exports **Body only** or **Headers + body**, preserving the raw response rather than the formatted JSON display. A truncated response exports only its available preview, with a visible notice. Binary bodies are not exported. File dialogs require Web bridge 2; older hosts keep sending/inspection available and disable file actions.

HTML responses collapse complete leading blank lines in the text viewer, keeping the first content line at the top. The footer shows the collapsed line count and lets you restore the original view. Internal whitespace, saved files and the editor preview retain the original response.

HTML responses expose **Preview**. The current public host API accepts workspace files rather than arbitrary HTML strings: this action asks where to save the response **inside the current local workspace**, then opens that file in the editor's **preview-only** presentation. It checks host capability availability and refuses an already-open target to avoid displaying an older live buffer. The file remains in the location you chose; there is no hidden response cache. HTML runs only in the host's separate HTML preview, without the plugin bridge. Native dialog and editor-preview acceptance are still pending for this preview.

## Scope and data handling

- The declared executable `bin/lithe-http-client` runs locally via the official Lithe plugin SDK. It performs HTTP(S) requests explicitly requested by the user. The Web UI only talks to the host bridge.
- Requests, session history and responses stay in memory until you explicitly save or preview. No automatic workspace scanning, file reads or draft persistence. The plugin reads only the chosen request file, and writes only the chosen export/HTML file with an atomic replacement. Application bundles, installed plugin resources, symbolic-link export targets and special files are refused. Closing/recreating the page discards history. HTML preview uses workspace metadata and document summaries to find the current root and avoid stale open buffers; it does not read other documents' contents.
- Inline `@variables`, headers, request bodies and `###` separators use the unchanged OpenIDEA parser/executor. Environment files, local body includes, response scripts and file redirects are unsupported. Includes and scripts/redirects fail explicitly before sending.
- 128 KiB input, 30-second overall request timeout, cancellable operations, configurable 1–512 KiB text preview (1 KiB steps, 128 KiB default). Upstream retains at most 16 MiB of network body. Received size can exceed the preview size; truncation is visible. Binary responses show status/headers without a body preview.
- Network/prepare errors are localized stable codes; raw request URLs and transport errors are not exposed in diagnostics. User-supplied text and server responses can contain secrets; this is a local HTTP client, not a redaction tool.
- Uses upstream default proxy behavior; Lithe's proxy settings are not synchronized. No custom TLS/credential/environment UI.
- macOS host chrome remains native; the plugin content is a themed Web page. This is not a replacement for the editor or a new host architecture.
- Community package with ad-hoc executable signature, not publisher-signed or notarized. Lithe handles program review/consent on install.

## Build and verify

Requires macOS, Node.js 22+, Python 3, Rust (edition 2024), Xcode command line tools, and the `x86_64-apple-darwin` Rust target. Pinning uses Cargo.lock and Git revisions; no runtime downloads.

```sh
npm ci
npm run build
npm run check
cargo build --release --locked
cargo build --release --locked --target x86_64-apple-darwin
cargo fmt --check
cargo clippy --locked -- -D warnings
python3 scripts/package.py
python3 scripts/test_protocol.py --binary dist/io.github.lithe-idea.http-client/bin/lithe-http-client
```

Use a consistent rustup `cargo`/`rustc` toolchain on PATH when cross-compiling. Packaging uses `lipo`, validates both architectures, signs the executable ad-hoc, checks its signature, includes dependency notices and creates `dist/http-client-0.1.2-darwin.zip` with one plugin-ID parent directory and a SHA-256 sidecar. Published release assets are immutable: fixes require a new version.

Protocol integration tests use real SDK processes and a loopback HTTP server, with bounded waits and cleanup. Individual timings and failures are emitted to `.artifacts/test-stability/index.html` and `junit.xml`.

Optional real Core integration (requires a compatible host Core library):

```sh
python3 scripts/test_core.py --core /path/to/liblithe_core.dylib --binary dist/io.github.lithe-idea.http-client/bin/lithe-http-client
```

Run that C ABI integration under an external 30-second process watchdog. `scripts/test_ui.js` launches a real SDK backend, a loopback HTTP server and headless Chrome. It checks caret/input/focus behavior, parsing/sending, highlighting, history, headers, resize/wrap, truncation, cancellation, real file reads/exports, install-directory refusal, localization and responsive layout. Run `node scripts/test_ui.js` after a debug build, or set `HTTP_CLIENT_BINARY=target/release/lithe-http-client`. For Playwright Chromium use `npx playwright install chromium` and `HTTP_CLIENT_BROWSER=chromium`; for WebKit use `npx playwright install webkit` and `HTTP_CLIENT_BROWSER=webkit`. Reports are `.artifacts/test-stability/ui.html` / `ui.junit.xml`; screenshots are under `.artifacts/`. The test bridge forwards real function calls and does not simulate native file dialogs or editor previews. Those flows still require native host acceptance.

## Architecture and attribution

The native Lithe host owns installation, activation, Web bridge, process lifecycle and cancellation. This plugin owns its UI and a thin Rust function adapter. HTTP parsing, variable resolution and transport come from unchanged `ide-http` / `ide-core` in [OpenIDEA](https://github.com/l0ng-ai/openidea), revision `3be40bd57c5718df39977c5f8b5d31f0ff3e692a` (Apache-2.0). The [official Rust SDK](https://github.com/Lithe-IDEA/lithe-plugin-docs) is a vendored source snapshot (Apache-2.0); `vendor/lithe-plugin-sdk/source-provenance.json` records its baseline, local changes, and file hashes.

This project's adapter and UI are Apache-2.0. Release packages retain original dependency license/notice texts and include `DEPENDENCIES.json` and `UPSTREAM.json`. Missing crate-distribution license files are supplemented from pinned upstream sources recorded in `licenses/SOURCES.json`. Upstream authors do not endorse this plugin.

## 中文说明

保留 Lithe 原生 Mac 工作台，在底部工具窗口提供独立 HTTP 面板。粘贴 `.http` 文本后可发送请求、取消、查看状态码／耗时／大小，切换正文与响应头，格式化 JSON。界面跟随宿主中英文和主题。首版仅支持 macOS；支持原生选择 `.http` / `.rest` 文件、请求高亮、会话历史、可拖动分栏、响应换行和原始内容保存。HTML 响应可先保存到当前工作区，再在编辑区预览。没有环境文件、正文文件引用、响应脚本或编辑器行内按钮；历史不会写入磁盘，只有显式保存或预览才写入选择的文件。原生文件对话框和编辑区 HTML 预览的完整验收仍待进行。

UI source is `ui/src/main.js`; translations live in `shared/i18n/`. `npm run build` bundles all editor code locally into `ui/main.js` and records bundled UI dependency licenses. Commit generated outputs; `npm run check` verifies the bundle, licenses and matching English/Chinese keys. Packaging copies those files verbatim and requires no runtime downloads.

## 宿主日志接入

后端使用官方 Rust SDK 的结构化 `lithe/log` 通知，通过
`experimental.litheLogging` 协商 v1；不创建日志文件、后台写入器或 stderr 回退。
Lithe macOS 将这些事实按共享事件目录写入本次会话的
`plugins/<plugin-id>/host.log`，统一决定级别、脱敏、限长、轮转和保留。
stdout 只承载 SDK 的协议帧，日志不写安装目录，不影响代码签名和增量更新。

SDK 在每个函数的最终返回边界记录一次成功或失败，包含注册的函数 ID、单调耗时
以及安全的错误分类，并关联宿主原始 operation ID；取消不当作失败。
高频 `requests.parse` 和预览能力探测的成功诊断被显式抑制。
响应预览因大小上限被截断时，`Context.diagnostics().degraded` 在本次后端生命周期
报告一次 `preview_truncated`；重复截断保持静默。
诊断不含 URL、请求或响应正文、头部、环境变量、凭据、文件路径或所选文件内容。
启动在协议通道建立前失败时以退出码交给宿主进程生命周期记录，不另行打印。

仓库内 `vendor/lithe-plugin-sdk/` 是同批官方 SDK 源码快照，Cargo 使用相对路径，
来源和逐文件 SHA-256 保存在其 `source-provenance.json`。这不是已发布的新版本或
虚构的 Git revision。插件不要求 `${logDir}`，也不自行落盘；结构化通知的展示与
持久化依赖支持新日志协议的宿主，不将旧宿主兼容路径作为本轮迁移目标。
