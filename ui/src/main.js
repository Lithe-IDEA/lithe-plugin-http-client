import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, keymap, placeholder, drawSelection } from '@codemirror/view';
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { http } from '@codemirror/legacy-modes/mode/http';
import { json as jsonBody } from '@codemirror/legacy-modes/mode/javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { tags } from '@lezer/highlight';
import { history as undoHistory, historyKeymap, defaultKeymap } from '@codemirror/commands';
import en from '../../shared/i18n/en-US.json';
import zh from '../../shared/i18n/zh-CN.json';

const chinese = String(window.lithe?.context?.locale || navigator.language).startsWith('zh');
const t = (key, params = {}) => ((chinese ? zh : en)[key] || en.failed).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match);
const $ = id => document.getElementById(id);
const bridge = window.lithe;
const nativeFiles = bridge?.version >= 2;
const INPUT_LIMIT = 128 * 1024;
const HISTORY_LIMIT = 20, HISTORY_BYTES = 1024 * 1024;
const bytes = text => new TextEncoder().encode(text).length;
document.documentElement.lang = chinese ? 'zh-CN' : 'en';
document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
document.querySelectorAll('[data-label]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.label)); });
document.querySelectorAll('[data-title]').forEach(el => {
  el.title = t(el.dataset.title); el.setAttribute('aria-label', t(el.dataset.title));
});
const sendShortcut = bridge?.context?.platform === 'macos' || /Mac/.test(navigator.platform) ? '⌘ ↵' : 'Ctrl ↵';
document.querySelectorAll('.shortcut, #empty-shortcut').forEach(el => { el.textContent = sendShortcut; });
$('send').title = t('sendShortcut', { shortcut: sendShortcut });

// Reuse CodeMirror's HTTP and JSON tokenizers; this wrapper only recognizes
// .http block separators and inline variables. Parsing/execution stays upstream.
const requestLanguage = StreamLanguage.define({
  startState: () => ({ http: http.startState(), json: jsonBody.startState(2), body: false }),
  copyState: state => ({ http: { ...state.http }, json: { ...state.json, cc: state.json.cc.slice() }, body: state.body }),
  blankLine(state) { state.body = true; },
  token(stream, state) {
    if (stream.sol()) {
      if (stream.match(/^\s*###.*$/)) { state.http = http.startState(); state.json = jsonBody.startState(2); state.body = false; return 'heading'; }
      if (stream.match(/^\s*(?:#|\/\/).*$/)) return 'comment';
      if (stream.match(/^\s*@[^=\s]+\s*=/)) return 'variableName';
      if (/^\s*[A-Z]+\s+\S/.test(stream.string)) { state.http = http.startState(); state.body = false; }
    }
    return state.body ? jsonBody.token(stream, state.json) : http.token(stream, state.http);
  },
});
const colors = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.heading, tags.bool, tags.null], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.atom, tags.propertyName, tags.variableName, tags.tagName], color: 'var(--syntax-property)' },
  { tag: [tags.comment, tags.meta], color: 'var(--muted)' },
  { tag: tags.number, color: 'var(--syntax-property)' },
]));
const editable = new Compartment(), wrapping = new Compartment(), responseLanguage = new Compartment();
let active = null, busy = false, cancelled = false, parsedText = null, parsedRequests = [], result = null, tab = 'body';
let history = [], fileName = '', changingSource = false, editEnabled = true, wrap = true, renderedResponse = null;
let inputSize = 0;
let statusKey = 'ready', statusError = false;
let whitespaceResult = null, leadingBlankLength = 0, leadingBlankCount = 0, showLeadingBlanks = false;
const requests = $('requests');
const source = new EditorView({
  parent: $('source'),
  extensions: [lineNumbers(), highlightActiveLine(), colors, requestLanguage, undoHistory(), drawSelection(),
    placeholder('GET http://localhost:8080/health'),
    editable.of(EditorView.editable.of(true)),
    EditorView.contentAttributes.of({ 'aria-label': t('source'), spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' }),
    keymap.of([...defaultKeymap, ...historyKeymap, { key: 'Tab', run(view) { view.dispatch(view.state.replaceSelection('  ')); return true; } }]),
    EditorView.updateListener.of(update => {
      if (!update.docChanged || changingSource) return;
      parsedText = null; parsedRequests = []; requests.replaceChildren();
      fileName = ''; updateFileName();
      inputSize = bytes(update.state.doc.toString());
      updateRequestChrome();
      status(inputSize > INPUT_LIMIT ? 'httpClient.inputTooLarge' : 'stale'); controls();
    }),
  ],
});
const response = new EditorView({
  parent: $('response'),
  extensions: [EditorState.readOnly.of(true), colors, wrapping.of(EditorView.lineWrapping), responseLanguage.of([]),
    EditorView.contentAttributes.of({ 'aria-label': t('response'), spellcheck: 'false' })],
});
function sourceText() { return source.state.doc.toString(); }
function setSource(text, name = '') {
  changingSource = true;
  try { source.dispatch({ changes: { from: 0, to: source.state.doc.length, insert: text }, selection: { anchor: 0 } }); }
  finally { changingSource = false; }
  parsedText = null; parsedRequests = []; requests.replaceChildren(); fileName = name; updateFileName();
  inputSize = bytes(text);
  updateRequestChrome();
}
function updateFileName() { $('file-name').textContent = fileName || t('openFile'); $('open-file').title = fileName || t('openFile'); }
function status(key, error = false) {
  statusKey = key; statusError = error;
  $('status').textContent = t(key); document.querySelector('footer').dataset.error = String(error);
  renderEmpty();
}
function renderEmpty() {
  const empty = $('response-empty');
  empty.hidden = Boolean(result);
  if (result) return;
  const mode = busy ? 'busy' : statusError ? 'error' : 'idle';
  empty.dataset.mode = mode;
  $('empty-title').textContent = t(mode === 'busy' ? 'working' : mode === 'error' ? 'responseFailed' : 'responseEmpty');
  $('empty-detail').textContent = t(mode === 'busy' ? 'responseWaiting' : statusError ? statusKey : statusKey === 'cancelled' ? 'cancelled' : 'responseEmptyHint');
  $('empty-shortcut').hidden = mode !== 'idle';
}
function updateRequestChrome() {
  if (!parsedRequests.length && !requests.options.length) requests.add(new Option(t('select'), ''));
  const item = parsedRequests.find(item => item.index === Number(requests.value));
  $('method').hidden = !item;
  $('method').textContent = item?.method || '';
  $('method').dataset.method = item?.method || '';
  requests.title = item ? `${item.method} ${item.url}` : t('select');
  const size = inputSize >= 1024 ? `${(inputSize / 1024).toFixed(1)} KiB` : `${inputSize} B`;
  $('request-info').textContent = parsedText != null ? `${t('requestCount', { count: parsedRequests.length })} · ${size}` : size;
}
function failed(error) {
  const wasCancelled = cancelled || error?.code === 'requestCancelled';
  status(wasCancelled ? 'cancelled' : error?.pluginErrorCode || 'failed', !wasCancelled);
}
function controls() {
  const hasSource = source.state.doc.length > 0;
  $('parse').disabled = busy || !bridge || !hasSource || inputSize > INPUT_LIMIT;
  $('send').disabled = busy || !bridge || !hasSource || inputSize > INPUT_LIMIT || !$('preview-limit').validity.valid;
  $('cancel').disabled = !active || cancelled;
  $('cancel').hidden = !busy;
  document.body.dataset.busy = String(busy);
  $('response-empty').setAttribute('aria-busy', String(busy));
  $('preview-limit').disabled = busy;
  $('open-file').disabled = busy || !nativeFiles;
  if (!nativeFiles) $('open-file').title = t('oldBridge');
  requests.disabled = busy || !parsedRequests.length;
  $('history').disabled = busy || !history.length;
  $('clear-history').disabled = busy || !history.length;
  $('pretty').disabled = busy || tab !== 'body' || !result || result.truncated || result.body == null;
  $('preview').disabled = busy || !nativeFiles || !result || result.truncated;
  $('save').disabled = busy || !nativeFiles || !result || result.body == null;
  $('save-mode').disabled = $('save').disabled;
  if (editEnabled !== !busy) { editEnabled = !busy; source.dispatch({ effects: editable.reconfigure(EditorView.editable.of(editEnabled)) }); }
  renderEmpty();
}
function isHTML() {
  const type = result?.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1].split(';')[0].trim().toLowerCase();
  return result?.body != null && (type === 'text/html' || type === 'application/xhtml+xml' || /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(result.body));
}
function render() {
  $('body-tab').setAttribute('aria-pressed', String(tab === 'body'));
  $('headers-tab').setAttribute('aria-pressed', String(tab === 'headers'));
  $('code').textContent = result ? String(result.status) : '';
  $('code').dataset.kind = result?.status >= 400 ? 'error' : 'success';
  $('code').title = result ? `${result.status} ${result.statusText}` : '';
  $('header-count').hidden = !result;
  $('header-count').textContent = result ? String(result.headers.length) : '';
  const type = result?.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1].split(';')[0].trim() || '';
  $('content-type').hidden = !type;
  $('content-type').textContent = type;
  $('content-type').title = type;
  $('metrics').textContent = result ? `${Math.round(result.totalMs)} ms · ${result.size >= 1024 ? (result.size / 1024).toFixed(1) + ' KiB' : result.size + ' B'}` : '';
  $('response').hidden = !result || tab === 'headers'; $('response-headers').hidden = !result || tab !== 'headers';
  document.querySelector('.pretty-label').hidden = tab !== 'body';
  $('preview').hidden = tab !== 'body' || !isHTML();
  $('notice').textContent = result?.truncated ? t('truncated') : result && result.body == null ? t('binary') : '';
  $('notice').title = $('notice').textContent;
  if (whitespaceResult !== result) {
    whitespaceResult = result;
    // HTML pages often start with template whitespace. Compact only complete
    // blank lines in the displayed document; result.body remains the raw export.
    const prefix = isHTML() ? result.body.match(/^(?:[\t ]*\r?\n)+/)?.[0] || '' : '';
    leadingBlankLength = prefix.length;
    leadingBlankCount = prefix.split('\n').length - 1;
    showLeadingBlanks = false;
  }
  const whitespaceToggle = $('leading-whitespace');
  whitespaceToggle.hidden = tab !== 'body' || !leadingBlankCount;
  whitespaceToggle.setAttribute('aria-pressed', String(showLeadingBlanks));
  whitespaceToggle.textContent = t(showLeadingBlanks ? 'collapseLeadingBlanks' : 'expandLeadingBlanks', { count: leadingBlankCount });
  whitespaceToggle.title = t('leadingBlanksHelp');
  // Tab, hover and resize changes never reformat or replace the response document.
  const identity = [result, $('pretty').checked, showLeadingBlanks];
  if (!renderedResponse || identity.some((value, index) => renderedResponse[index] !== value)) {
    renderedResponse = identity;
    let text = result?.body ?? '';
    if (!showLeadingBlanks && leadingBlankLength) text = text.slice(leadingBlankLength);
    let language = isHTML() ? html() : [];
    if (result?.body != null && !result.truncated) {
      try {
        const value = JSON.parse(text); language = json();
        if ($('pretty').checked) { const pretty = JSON.stringify(value, null, 2); if (pretty.length <= 2 * 1024 * 1024) text = pretty; }
      } catch { /* Preserve non-JSON text exactly. */ }
    }
    response.dispatch({ changes: { from: 0, to: response.state.doc.length, insert: text },
      selection: { anchor: 0 }, scrollIntoView: true, effects: responseLanguage.reconfigure(language) });
  }
  renderHeaders(); controls(); response.requestMeasure();
}
let renderedHeaders = null;
function renderHeaders() {
  if (renderedHeaders === result) return;
  renderedHeaders = result;
  const container = $('response-headers'); container.replaceChildren();
  if (!result) return;
  const protocol = document.createElement('p'); protocol.className = 'response-protocol';
  protocol.textContent = `${result.version} ${result.status} ${result.statusText}`; container.append(protocol);
  for (const [key, value] of result.headers) {
    const detail = document.createElement('details'), summary = document.createElement('summary'); summary.title = t('expandHeader');
    const name = document.createElement('span'); name.className = 'header-key'; name.textContent = key; name.title = key;
    const preview = document.createElement('span'); preview.className = 'header-preview'; preview.textContent = value;
    const full = document.createElement('div'); full.className = 'header-value'; full.textContent = value;
    summary.append(name, preview); detail.append(summary, full); container.append(detail);
  }
}
async function invoke(name, params) {
  active = crypto.randomUUID(); controls();
  try {
    const reply = await bridge.request('functions.invoke', { function: name, params, call: active });
    return cancelled ? null : reply.value;
  } finally { active = null; controls(); }
}
async function parse(index = null) {
  const text = sourceText(); parsedText = null; requests.replaceChildren();
  if (bytes(text) > INPUT_LIMIT) { status('httpClient.inputTooLarge', true); return false; }
  const value = await invoke('requests.parse', { text });
  if (!value) return false;
  parsedRequests = value.requests;
  for (const item of parsedRequests) requests.add(new Option(item.name || item.url, String(item.index)));
  parsedText = text;
  if (!requests.options.length) { updateRequestChrome(); status('empty'); return false; }
  if (index != null && parsedRequests.some(item => item.index === index)) requests.value = String(index);
  updateRequestChrome();
  revealSelectedRequest();
  return true;
}
function renderHistory() {
  const select = $('history'); select.replaceChildren(new Option(t('emptyHistory'), ''));
  select.options[0].textContent = history.length ? t('chooseHistory') : t('emptyHistory');
  history.forEach((entry, index) => select.add(new Option(entry.label, String(index))));
  $('history-count').hidden = !history.length;
  $('history-count').textContent = String(history.length);
}
function remember() {
  const item = parsedRequests.find(item => item.index === Number(requests.value));
  const entry = { text: sourceText(), index: Number(requests.value), fileName, label: `${item.method} ${item.name || item.url}` };
  history = history.filter(old => old.text !== entry.text || old.index !== entry.index);
  history.unshift(entry); history = history.slice(0, HISTORY_LIMIT);
  let total = 0; history = history.filter(item => (total += bytes(item.text)) <= HISTORY_BYTES);
  renderHistory();
}
async function operation(action) {
  if (busy || !bridge) return;
  busy = true; cancelled = false; controls(); status('working');
  try { await action(); } catch (error) { failed(error); }
  finally { if (cancelled) status('cancelled'); busy = false; render(); }
}
async function run(execute, index = null) {
  if (!sourceText().trim()) return;
  await operation(async () => {
    if (execute) { result = null; render(); }
    if (!execute || parsedText !== sourceText()) { if (!await parse(index)) return; }
    if (cancelled) return;
    if (execute) {
      result = await invoke('requests.execute', { text: sourceText(), index: Number(requests.value), previewLimitKiB: Number($('preview-limit').value) });
      if (result) remember();
    }
    status('ready');
  });
}
function revealSelectedRequest() {
  updateRequestChrome();
  const item = parsedRequests.find(item => item.index === Number(requests.value));
  if (!item) return;
  const line = source.state.doc.line(Math.min(source.state.doc.lines, item.line + 1));
  source.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
}
requests.addEventListener('change', revealSelectedRequest);
$('parse').addEventListener('click', () => run(false));
$('send').addEventListener('click', () => run(true));
$('cancel').addEventListener('click', async () => {
  if (!active || cancelled) return;
  const call = active; cancelled = true; controls(); status('cancelling');
  try { await bridge.request('functions.cancel', { call }); }
  catch { if (active === call) status('failed', true); }
});
$('open-file').addEventListener('click', () => operation(async () => {
  const { path } = await bridge.request('dialog.openFile', { title: t('openFile'), extensions: ['http', 'rest'] });
  if (!path) { status('ready'); return; }
  const value = await invoke('requests.openFile', { path });
  if (!value) return;
  setSource(value.text, value.name);
  if (await parse()) status('fileLoaded');
}));
$('history').addEventListener('change', async () => {
  if ($('history').value === '' || busy) return;
  const entry = history[Number($('history').value)];
  setSource(entry.text, entry.fileName); await run(false, entry.index);
});
$('clear-history').addEventListener('click', () => { history = []; renderHistory(); controls(); });
for (const name of ['body', 'headers']) $(name + '-tab').addEventListener('click', () => { tab = name; render(); });
$('pretty').addEventListener('change', render);
$('leading-whitespace').addEventListener('click', () => { showLeadingBlanks = !showLeadingBlanks; render(); });
$('preview-limit').addEventListener('input', controls);
$('wrap').addEventListener('click', () => {
  wrap = !wrap; $('wrap').setAttribute('aria-pressed', String(wrap));
  response.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
  $('response-headers').classList.toggle('no-wrap', !wrap);
});
function exportText(all) {
  const body = result.body;
  return all ? `${result.version} ${result.status} ${result.statusText}\r\n${result.headers.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}` : body;
}
function extension() {
  if (isHTML()) return 'html';
  const type = result.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
  return /json/i.test(type) ? 'json' : /xml/i.test(type) ? 'xml' : 'txt';
}
async function save(preview) {
  if (!result || result.body == null) return;
  await operation(async () => {
    if (preview) {
      if (!await invoke('response.previewInfo', {})) return;
    }
    const all = !preview && $('save-mode').value === 'all';
    const ext = all ? 'txt' : extension();
    const { path } = await bridge.request('dialog.saveFile', { title: t(preview ? 'previewTitle' : 'save'), suggestedName: `response.${ext}`, extensions: [ext] });
    if (!path) { status('ready'); return; }
    const value = await invoke('response.save', { path, text: exportText(all), preview });
    if (value) status(preview ? 'previewSaved' : 'saved');
  });
}
$('save').addEventListener('click', () => save(false));
$('preview').addEventListener('click', () => save(true));
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); run(true); }
});

// A resize session owns capture and one animation frame; moving the divider
// updates only its grid variable. Editors keep their documents and viewport.
const main = document.querySelector('main'), splitter = $('splitter');
let ratio = .5, drag = null, frame = null, nextRatio = ratio;
const stacked = () => matchMedia('(max-width: 720px)').matches;
function setRatio(value) {
  const rect = main.getBoundingClientRect(), size = stacked() ? rect.height : rect.width;
  const min = Math.min(.4, 180 / Math.max(size, 1));
  ratio = Math.min(1 - min, Math.max(min, value));
  main.style.setProperty('--request-width', `calc((100% - 5px) * ${ratio})`);
  splitter.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  splitter.setAttribute('aria-valuemin', String(Math.round(min * 100)));
  splitter.setAttribute('aria-valuemax', String(Math.round((1 - min) * 100)));
  splitter.setAttribute('aria-orientation', stacked() ? 'horizontal' : 'vertical');
}
function finishResize(event) {
  if (!drag || (event?.pointerId != null && event.pointerId !== drag.id)) return;
  if (frame != null) { cancelAnimationFrame(frame); frame = null; setRatio(nextRatio); }
  const id = drag.id; drag = null; document.body.classList.remove('resizing');
  if (splitter.hasPointerCapture(id)) splitter.releasePointerCapture(id);
}
splitter.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault(); drag = { id: event.pointerId }; splitter.setPointerCapture(event.pointerId); document.body.classList.add('resizing');
});
splitter.addEventListener('pointermove', event => {
  if (!drag || drag.id !== event.pointerId) return;
  const rect = main.getBoundingClientRect();
  nextRatio = stacked() ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
  if (frame == null) frame = requestAnimationFrame(() => { frame = null; setRatio(nextRatio); });
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) splitter.addEventListener(event, finishResize);
window.addEventListener('blur', () => finishResize());
splitter.addEventListener('dblclick', () => setRatio(.5));
splitter.addEventListener('keydown', event => {
  const decrease = stacked() ? 'ArrowUp' : 'ArrowLeft', increase = stacked() ? 'ArrowDown' : 'ArrowRight';
  if ([decrease, increase, 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); setRatio(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : ratio + (event.key === decrease ? -.02 : .02));
  }
});
window.addEventListener('resize', () => { finishResize(); setRatio(ratio); });
window.addEventListener('pagehide', () => { finishResize(); source.destroy(); response.destroy(); });
renderHistory(); updateRequestChrome(); setRatio(ratio); status(bridge ? 'ready' : 'bridge'); render();
