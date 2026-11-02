"use strict";
const messages = {
  en: { previewLimit: "Body preview", expandHeader: "Expand or collapse header value", source: "Request · .http", response: "Response", select: "Select request", parse: "Read requests", send: "Send", cancel: "Cancel", ready: "Ready", empty: "No requests found. Check the request line.", working: "Working…", cancelling: "Cancelling…", cancelled: "Cancelled", truncated: "Response preview truncated. Increase the preview limit and send again; escaped content may reach the transport limit earlier.", binary: "Binary response — text preview unavailable.", bridge: "Open this plugin in Lithe to send requests.", failed: "Request failed. Try again.", body: "Body", headers: "Headers", pretty: "Format JSON", memory: "Not saved to disk", hint: "Send a request to inspect its response.", stale: "Request changed. Send will read it again.", "httpClient.invalidInput": "Invalid or oversized input (maximum 128 KiB).", "httpClient.fileIncludeUnsupported": "Local file includes are not supported. Paste the body instead.", "httpClient.handlerUnsupported": "Response scripts and file redirects are not supported. Remove them before sending.", "httpClient.prepareFailed": "Check request syntax and inline variables. Environment files are not loaded.", "httpClient.invalidScheme": "Only HTTP and HTTPS are supported.", "httpClient.timeout": "The request exceeded 30 seconds.", "httpClient.transportFailed": "Connection failed. Check the URL, network and certificate.", "httpClient.responseTooLarge": "Response metadata exceeds the plugin limit." },
  zh: { previewLimit: "正文预览上限", expandHeader: "展开或收起响应头值", source: "请求 · .http", response: "响应", select: "选择请求", parse: "读取请求", send: "发送", cancel: "取消", ready: "就绪", empty: "未找到请求，请检查请求行。", working: "处理中…", cancelling: "正在取消…", cancelled: "已取消", truncated: "响应预览已截断。可调高预览上限后重新发送；含转义字符的内容可能先达到传输上限。", binary: "二进制响应，无法预览文本。", bridge: "请在 Lithe 中打开此插件以发送请求。", failed: "请求失败，请重试。", body: "正文", headers: "响应头", pretty: "格式化 JSON", memory: "不保存到磁盘", hint: "发送请求后在此查看响应。", stale: "请求已修改，发送时会重新读取。", "httpClient.invalidInput": "输入无效或超过 128 KiB。", "httpClient.fileIncludeUnsupported": "暂不支持本地文件引用，请直接粘贴正文。", "httpClient.handlerUnsupported": "暂不支持响应脚本和文件重定向，请移除后再发送。", "httpClient.prepareFailed": "请检查请求语法与内联变量；不会加载环境文件。", "httpClient.invalidScheme": "仅支持 HTTP 和 HTTPS。", "httpClient.timeout": "请求超过 30 秒。", "httpClient.transportFailed": "连接失败，请检查地址、网络与证书。", "httpClient.responseTooLarge": "响应元数据超过插件限制。" }
};
const chinese = String(window.lithe?.context?.locale || navigator.language).startsWith("zh");
const t = key => (chinese ? messages.zh : messages.en)[key] || messages.en.failed;
document.documentElement.lang = chinese ? "zh-CN" : "en";
document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
document.querySelectorAll("[data-label]").forEach(el => { el.setAttribute("aria-label", t(el.dataset.label)); });
const $ = id => document.getElementById(id);
const source = $("source"), requests = $("requests"), response = $("response");
const parseButton = $("parse"), send = $("send"), cancel = $("cancel");
let active = null, busy = false, parsedText = null, cancelled = false, result = null, tab = "body";
source.placeholder = "### Health\nGET http://localhost:8080/health\nAccept: application/json";
response.placeholder = t("hint");
function status(key, error = false) { $("status").textContent = t(key); document.querySelector("footer").dataset.error = String(error); }
function controls() {
  parseButton.disabled = busy || !window.lithe || !source.value.trim();
  send.disabled = busy || !window.lithe || !source.value.trim();
  cancel.disabled = !active || cancelled;
  $("preview-limit").disabled = busy;
  source.disabled = busy; requests.disabled = busy || !requests.options.length;
  $("pretty").disabled = tab !== "body" || !result || result.truncated || result.body == null;
}
function render() {
  $("body-tab").setAttribute("aria-pressed", String(tab === "body"));
  $("headers-tab").setAttribute("aria-pressed", String(tab === "headers"));
  $("code").textContent = result ? String(result.status) : "";
  $("code").dataset.kind = result?.status >= 400 ? "error" : "success";
  $("metrics").textContent = result ? `${Math.round(result.totalMs)} ms · ${result.size >= 1024 ? (result.size / 1024).toFixed(1) + " KiB" : result.size + " B"}` : "";
  let content = "";
  if (result) {
    content = tab === "headers" ? `${result.version} ${result.status} ${result.statusText}\n${result.headers.map(([k,v]) => `${k}: ${v}`).join("\n")}` : result.body ?? t("binary");
    if (tab === "body" && $("pretty").checked && !result.truncated && result.body != null) {
      try { const formatted = JSON.stringify(JSON.parse(content), null, 2); if (formatted.length <= 2 * 1024 * 1024) content = formatted; } catch { /* Non-JSON stays verbatim. */ }
    }
  }
  response.value = content;
  response.hidden = tab === "headers";
  $("response-headers").hidden = tab !== "headers";
  document.querySelector(".pretty-label").hidden = tab !== "body";
  renderHeaders();
  $("notice").hidden = tab !== "body" || !result?.truncated;
  $("notice").textContent = result?.truncated ? t("truncated") : "";
  controls();
}
let renderedHeaders = null;
function renderHeaders() {
  if (renderedHeaders === result) return;
  renderedHeaders = result;
  const container = $("response-headers");
  container.replaceChildren();
  if (!result) return;
  const protocol = document.createElement("p");
  protocol.className = "response-protocol";
  protocol.textContent = `${result.version} ${result.status} ${result.statusText}`;
  container.append(protocol);
  for (const [key, value] of result.headers) {
    const detail = document.createElement("details");
    const summary = document.createElement("summary");
    summary.title = t("expandHeader");
    const name = document.createElement("span"); name.className = "header-key"; name.textContent = key;
    const preview = document.createElement("span"); preview.className = "header-preview"; preview.textContent = value;
    const full = document.createElement("div"); full.className = "header-value"; full.textContent = value;
    summary.append(name, preview); detail.append(summary, full); container.append(detail);
  }
}
async function invoke(name, params) {
  active = crypto.randomUUID(); controls();
  try {
    const reply = await window.lithe.request("functions.invoke", { function: name, params, call: active });
    if (cancelled) return null;
    return reply.value;
  } finally { active = null; controls(); }
}
async function parse() {
  const text = source.value;
  parsedText = null; requests.replaceChildren();
  const value = await invoke("requests.parse", { text });
  if (!value) return false;
  for (const item of value.requests) requests.add(new Option(`${item.method} ${item.name || item.url}`, String(item.index)));
  parsedText = text;
  if (!requests.options.length) { status("empty"); return false; }
  return true;
}
async function run(execute) {
  if (busy || !window.lithe || !source.value.trim()) return;
  busy = true; cancelled = false; result = null; render(); status("working");
  try {
    if (!execute || parsedText !== source.value) { if (!await parse()) return; }
    if (cancelled) return;
    if (execute) result = await invoke("requests.execute", { text: source.value, index: Number(requests.value), previewLimitKiB: Number($("preview-limit").value) });
    status("ready");
  } catch (error) {
    const wasCancelled = cancelled || error?.code === "requestCancelled";
    status(wasCancelled ? "cancelled" : error?.pluginErrorCode || "failed", !wasCancelled);
  } finally {
    if (cancelled) status("cancelled");
    busy = false; render();
  }
}
parseButton.addEventListener("click", () => run(false));
send.addEventListener("click", () => run(true));
cancel.addEventListener("click", async () => {
  if (!active || cancelled) return;
  const call = active; cancelled = true; controls(); status("cancelling");
  try { await window.lithe.request("functions.cancel", { call }); }
  catch { if (active === call) status("failed", true); }
});
source.addEventListener("input", () => { parsedText = null; requests.replaceChildren(); status("stale"); controls(); });
for (const name of ["body", "headers"]) $(name + "-tab").addEventListener("click", () => { tab = name; render(); });
$("pretty").addEventListener("change", render);
document.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); run(true); } });
status(window.lithe ? "ready" : "bridge"); render();
