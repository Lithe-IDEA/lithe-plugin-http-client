// Real browser + SDK backend integration; the loopback server routes bridge
// calls to the plugin process. Native-only dialogs/preview are not simulated.
const { chromium, webkit } = require('playwright');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { readFile, mkdtemp, rm, writeFile, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, extname } = require('node:path');
const assert = require('node:assert/strict');
const root = resolve(__dirname, '..');
const pending = new Map(), calls = new Map(), heldResponses = new Set();
let sequence = 0, buffer = Buffer.alloc(0), backend, server, browser, temporary;
const records = [];

function send(message) {
  const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  backend.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${data.length}\r\n\r\n`), data]));
}
function request(method, params) {
  const id = ++sequence;
  const result = new Promise((accept, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id); send({ method: '$/cancelRequest', params: { id } });
      reject(new Error(`${method} exceeded 8 seconds`));
    }, 8000);
    pending.set(id, { accept, reject, timer }); send({ id, method, params });
  });
  return { id, result };
}
async function check(name, action) {
  const started = performance.now(); let failure;
  try { await action(); } catch (error) { failure = error; throw error; }
  finally { records.push({ name, seconds: (performance.now() - started) / 1000, failure: failure?.stack }); }
}
const escape = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'lithe-http-ui-'));
  backend = spawn(resolve(root, process.env.HTTP_CLIENT_BINARY || 'target/debug/lithe-http-client'), [], {
    cwd: temporary, stdio: ['pipe', 'pipe', 'inherit'],
  });
  backend.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const head = buffer.indexOf('\r\n\r\n'); if (head < 0) break;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, head).toString())[1]);
      if (buffer.length < head + 4 + length) break;
      const message = JSON.parse(buffer.subarray(head + 4, head + 4 + length)); buffer = buffer.subarray(head + 4 + length);
      const entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(message.error) : entry.accept(message.result); }
    }
  });
  backend.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  await request('initialize', { rootUri: new URL(`file://${temporary}/`).href, capabilities: { experimental: { litheFunctions: { versions: [1, 2, 3] }, litheLogging: { versions: [1] } } } }).result;
  send({ method: 'initialized', params: {} });
  const bridgeSource = `window.lithe = { version: 1, context: { locale: new URL(location.href).searchParams.get('locale') || 'en', platform: 'macos' }, request: async (method, params) => {
    const response = await fetch('/bridge', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
    const reply = await response.json(); if (reply.error) throw reply.error; return reply.result;
  }};`;
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/slow') { heldResponses.add(res); res.on('close', () => heldResponses.delete(res)); return; }
      if (url.pathname === '/api/json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Test': 'one; two; three' });
        res.end(JSON.stringify({ ok: true, unicode: '世界', long: 'x'.repeat(1600) })); return;
      }
      if (url.pathname === '/api/html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        // Same six leading blank lines as the GitHub HTML regression. Internal
        // blank lines must remain visible when only the leading ones collapse.
        res.end('\n\n\n\n  \n\n<!doctype html>\n<html>\n\n<body><h1>Real loopback response</h1><script>window.injected=true</script></body></html>'); return;
      }
      if (url.pathname === '/api/large') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '好'.repeat(100000) })); return; }
      if (url.pathname === '/bridge') {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Bridge input too large'); chunks.push(chunk); }
        const { method, params } = JSON.parse(Buffer.concat(chunks)); let result;
        if (method === 'functions.cancel') { const id = calls.get(params.call); if (id) send({ method: '$/cancelRequest', params: { id } }); result = {}; }
        else if (method === 'functions.invoke') {
          const operation = request('lithe/function/invoke', { functionID: params.function, params: params.params, operationID: params.call });
          calls.set(params.call, operation.id);
          try { result = { value: await operation.result }; }
          finally { calls.delete(params.call); }
        } else throw new Error(`Native-only or unknown bridge method: ${method}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result })); return;
      }
      if (url.pathname === '/bridge.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bridgeSource); return; }
      const isAsset = url.pathname.startsWith('/assets/');
      const base = resolve(root, isAsset ? 'assets' : 'ui');
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(isAsset ? 8 : 1);
      const file = resolve(base, name);
      if (!file.startsWith(base + '/')) throw new Error('Invalid path');
      let data = await readFile(file);
      if (name === 'index.html') data = Buffer.from(data.toString().replace('<script src="main.js"', '<script src="/bridge.js"></script><script src="main.js"'));
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)],
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'none'; form-action 'none'" }).end(data);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: error.code === -32800 ? 'requestCancelled' : error.code, pluginErrorCode: error.data?.code, message: error.message } }));
    }
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = process.env.HTTP_CLIENT_BROWSER === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ ...(process.env.HTTP_CLIENT_BROWSER === 'chromium' ? {} : { channel: 'chrome' }), headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 720 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('Browser:', error.stack); });
  await page.goto(url);
  const input = page.locator('#source .cm-content');
  const text = async value => { await input.fill(value); };
  const ready = async () => { await page.locator('#send').waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.getElementById('send').disabled); };
  const sendRequest = async () => { await page.locator('#send').click(); await page.waitForFunction(() => document.getElementById('code').textContent === '200'); await ready(); };
  await check('empty-editor-caret-input-focus-and-shared-icon', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
    assert.deepEqual(manifest.ui.toolWindows[0].icon, { path: 'assets/http.svg', mode: 'template' });
    assert.match(await page.locator('.workspace-mark .globe-icon').evaluate(el => getComputedStyle(el).maskImage), /assets\/http\.svg/);
    const asset = await page.request.get(url + '/assets/http.svg');
    assert.equal(await asset.text(), await readFile(join(root, 'assets/http.svg'), 'utf8'));
    const hint = page.locator('#source .cm-placeholder');
    const hintBox = await hint.boundingBox();
    await page.mouse.click(hintBox.x + 80, hintBox.y + hintBox.height / 2);
    const singleLineCaret = async () => {
      await page.waitForFunction(() => {
        const cursor = document.querySelector('#source .cm-cursor-primary');
        const content = document.querySelector('#source .cm-content');
        return cursor && cursor.getBoundingClientRect().height > 0 &&
          cursor.getBoundingClientRect().height <= parseFloat(getComputedStyle(content).lineHeight) * 1.1;
      });
      assert.equal(await page.locator('#source .cm-cursor-primary').count(), 1);
      assert.equal(await input.evaluate(el => getComputedStyle(el).caretColor), 'rgba(0, 0, 0, 0)');
    };
    await singleLineCaret();
    assert.ok(hintBox.height <= await input.evaluate(el => parseFloat(getComputedStyle(el).lineHeight) * 1.1), 'Placeholder must occupy one line');
    assert.equal(await page.locator('#send').isDisabled(), true, 'Placeholder is not a request draft');
    await page.locator('.request-pane').screenshot({ animations: 'disabled', path: join(root, '.artifacts/http-client-caret.png') });
    await page.keyboard.insertText('GET http://localhost:8080/health');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('Accept: application/json');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.insertText('X');
    assert.equal(await input.innerText(), 'GET http://localhost:8080/health\nAccept: application/jsoXn');
    assert.equal(await hint.count(), 0);
    await singleLineCaret();
    await input.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    assert.equal(await hint.count(), 1);
    assert.equal(await page.locator('#source .cm-line').count(), 1);
    await singleLineCaret();
    await page.locator('#preview-limit').focus();
    await page.waitForFunction(() => !document.querySelector('#source .cm-editor').classList.contains('cm-focused'));
    await input.click();
    await singleLineCaret();
  });
  await check('real-send-highlight-history-headers', async () => {
    assert.equal(await page.locator('#preview-limit').inputValue(), '128');
    assert.equal(await page.locator('#response-empty').isVisible(), true);
    await page.screenshot({ path: join(root, '.artifacts/http-client-empty.png') });
    await text(`@base = ${url}\n### JSON\nGET {{base}}/api/json\nAccept: application/json\n\n### HTML\nGET {{base}}/api/html`);
    await page.locator('#parse').click(); await ready();
    assert.equal(await page.locator('#requests option').count(), 2);
    assert.equal(await page.locator('#method').innerText(), 'GET');
    await sendRequest();
    assert.match(await page.locator('#response .cm-content').innerText(), /"ok": true/);
    assert.equal(await page.locator('#history option').count(), 2);
    assert.equal(await page.locator('#response-empty').isVisible(), false);
    assert.equal(await page.locator('#history-count').innerText(), '1');
    assert.equal(await page.locator('#content-type').innerText(), 'application/json');
    assert.ok(await page.locator('#source .cm-content span[style], #source .cm-content span[class]').count() > 0);
    await page.locator('#headers-tab').click();
    assert.match(await page.locator('#response-headers').innerText(), /content-type/);
    assert.equal(await page.locator('.header-key').first().evaluate(el => getComputedStyle(el).fontFamily), await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily));
    await page.locator('#response-headers details').first().locator('summary').click();
    assert.ok(await page.locator('#response-headers details').first().getAttribute('open') !== null);
    await page.locator('#body-tab').click();
  });
  await check('compact-toolbar-resize-wrap-and-selection', async () => {
    const bar = await page.locator('.response-tools').boundingBox(); assert.ok(bar.height <= 36, `Response toolbar is ${bar.height}px`);
    await page.locator('#wrap').click();
    assert.equal(await page.locator('#wrap').getAttribute('aria-pressed'), 'false');
    await page.waitForFunction(() => { const el = document.querySelector('#response .cm-scroller'); return el.scrollWidth > el.clientWidth; });
    const before = await page.locator('.request-pane').boundingBox();
    const divider = await page.locator('#splitter').boundingBox();
    await page.mouse.move(divider.x + 2, divider.y + 70); await page.mouse.down(); await page.mouse.move(divider.x - 220, divider.y + 70, { steps: 10 }); await page.mouse.up();
    const after = await page.locator('.request-pane').boundingBox(); assert.ok(before.width - after.width > 200);
    assert.match(await page.locator('#response .cm-content').innerText(), /"ok": true/);
    await page.locator('#splitter').focus(); await page.keyboard.press('ArrowRight');
    assert.ok((await page.locator('.request-pane').boundingBox()).width > after.width);
    await page.locator('#wrap').click();
    await page.screenshot({ path: join(root, '.artifacts/http-client-light.png') });
  });
  await check('html-stays-text-and-is-previewable', async () => {
    await page.locator('#requests').selectOption('1'); await sendRequest();
    assert.equal(await page.locator('#preview').isVisible(), true);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.match(await page.locator('#response .cm-content').innerText(), /<!doctype html>/);
    assert.equal(await page.locator('#response .cm-line').first().innerText(), '<!doctype html>');
    assert.match(await page.locator('#leading-whitespace').innerText(), /6/);
    const firstLine = await page.locator('#response .cm-line').first().boundingBox();
    const viewport = await page.locator('.response-content').boundingBox();
    assert.ok(firstLine.y - viewport.y < 20, 'HTML must start at the top of the response viewport');
    await page.locator('#leading-whitespace').click();
    assert.equal(await page.locator('#leading-whitespace').getAttribute('aria-pressed'), 'true');
    const original = await page.locator('#response .cm-line').allTextContents();
    assert.equal(original.slice(0, 6).join('').trim(), '');
    assert.equal(original[6], '<!doctype html>');
    await page.locator('#leading-whitespace').click();
    assert.equal(await page.locator('#response .cm-line').first().innerText(), '<!doctype html>');
    const compact = await page.locator('#response .cm-line').allTextContents();
    assert.equal(compact[2].trim(), '', 'Internal blank lines must be preserved');
    await page.locator('#history').selectOption('1'); await ready();
    assert.equal(await page.locator('#requests').inputValue(), '0');
    await page.locator('#clear-history').click(); assert.equal(await page.locator('#history option').count(), 1);
  });
  await check('truncated-large-response-and-cancellation', async () => {
    await text(`GET ${url}/api/large`); await page.locator('#preview-limit').fill('48'); await sendRequest();
    assert.match(await page.locator('#notice').innerText(), /truncated/);
    assert.equal(await page.locator('#pretty').isDisabled(), true);
    assert.ok(await page.locator('#response .cm-line').count() < 100, 'Response must use a viewport');
    await text(`GET ${url}/api/slow`); await page.locator('#send').click();
    await page.waitForFunction(() => !document.getElementById('cancel').disabled);
    assert.equal(await page.locator('#response-empty').getAttribute('data-mode'), 'busy');
    await page.locator('#cancel').click(); await ready();
    assert.equal(await page.locator('#status').innerText(), 'Cancelled');
    assert.equal(await page.locator('#code').innerText(), '');
  });
  await check('real-file-open-export-and-install-readonly', async () => {
    const file = join(temporary, 'sample.http'); const source = `GET ${url}/api/json`;
    await writeFile(file, source);
    const opened = await request('lithe/function/invoke', { functionID: 'requests.openFile', operationID: 'file-open', params: { path: file } }).result;
    assert.equal(opened.text, source);
    const target = join(temporary, 'response.txt');
    const body = 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n世界\n';
    await request('lithe/function/invoke', { functionID: 'response.save', operationID: 'file-save', params: { path: target, text: body } }).result;
    assert.equal(await readFile(target, 'utf8'), body);
    const app = join(temporary, 'ReadOnly.app'); await mkdir(app);
    await assert.rejects(request('lithe/function/invoke', { functionID: 'response.save', operationID: 'file-refused', params: { path: join(app, 'response.txt'), text: body } }).result,
      error => error.data?.code === 'httpClient.fileWriteFailed');
    await assert.rejects(request('lithe/function/invoke', { functionID: 'response.previewInfo', operationID: 'preview-unavailable', params: {} }).result,
      error => error.data?.code === 'httpClient.previewUnavailable');
  });
  await check('chinese-dark-and-narrow-layout', async () => {
    await page.goto(url + '/?locale=zh-CN'); await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await text(`GET ${url}/api/json`); await sendRequest();
    assert.equal(await page.locator('#send [data-i18n="send"]').innerText(), '发送');
    await page.screenshot({ path: join(root, '.artifacts/http-client-dark.png') });
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await page.screenshot({ path: join(root, '.artifacts/http-client-zh-light.png') });
    await page.setViewportSize({ width: 600, height: 800 });
    await page.waitForFunction(() => document.getElementById('splitter').getAttribute('aria-orientation') === 'horizontal');
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
    const first = await page.locator('.request-pane').boundingBox(), second = await page.locator('.response-pane').boundingBox();
    assert.ok(second.y > first.y + first.height);
    await page.screenshot({ animations: 'disabled', path: join(root, '.artifacts/http-client-narrow.png') });
    await page.setViewportSize({ width: 960, height: 320 });
    await page.waitForFunction(() => document.getElementById('splitter').getAttribute('aria-orientation') === 'vertical');
    for (const selector of ['.selection', '.response-tools', '.workspace-toolbar']) {
      assert.equal(await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `${selector} overflows in a docked panel`);
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ animations: 'disabled', path: join(root, '.artifacts/http-client-docked.png') });
    assert.deepEqual(errors, []);
  });
  // Optional design capture uses the actual public API, outside deterministic
  // integration tests. Never insert invented response data for screenshots.
  if (process.env.HTTP_CLIENT_CAPTURE === '1') {
    await page.setViewportSize({ width: 1440, height: 580 });
    await text('### Lithe HTTP Client\nGET https://api.github.com/repos/Lithe-IDEA/lithe-plugin-http-client\nAccept: application/vnd.github+json\nUser-Agent: Lithe-HTTP-Client\n\n### Languages\nGET https://api.github.com/repos/Lithe-IDEA/lithe-plugin-http-client/languages\nAccept: application/vnd.github+json\nUser-Agent: Lithe-HTTP-Client');
    page.setDefaultTimeout(10000);
    await sendRequest();
    await page.screenshot({ animations: 'disabled', path: join(root, '.artifacts/http-client-design-light.png') });
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.screenshot({ animations: 'disabled', path: join(root, '.artifacts/http-client-design-dark.png') });
    await page.locator('#headers-tab').click();
    await page.screenshot({ animations: 'disabled', path: join(root, '.artifacts/http-client-design-headers.png') });
  }
  if (process.env.HTTP_CLIENT_CAPTURE_HTML === '1') {
    await page.setViewportSize({ width: 1440, height: 330 });
    await page.locator('#body-tab').click();
    await text('GET https://github.com/FxRayHughes/lithe-plugin-mise');
    page.setDefaultTimeout(10000);
    await page.locator('#preview-limit').fill('512');
    await sendRequest();
    assert.equal(await page.locator('#response .cm-line').first().innerText(), '<!DOCTYPE html>');
    await page.screenshot({ animations: 'disabled', path: join(root, '.artifacts/http-client-html-compact.png') });
    await page.locator('#leading-whitespace').click();
    await page.screenshot({ animations: 'disabled', path: join(root, '.artifacts/http-client-html-original.png') });
    await page.locator('#headers-tab').click();
    await page.locator('#preview-limit').fill('128');
    await page.screenshot({ animations: 'disabled', path: join(root, '.artifacts/http-client-headers-light.png') });
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.screenshot({ animations: 'disabled', path: join(root, '.artifacts/http-client-headers-dark.png') });
    assert.deepEqual(errors, []);
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  for (const res of heldResponses) res.destroy();
  server?.closeAllConnections(); server?.close();
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Test ended')); } pending.clear();
  if (backend && backend.exitCode === null) {
    const exited = new Promise(accept => backend.once('exit', accept));
    backend.stdin.end(); backend.kill('SIGTERM');
    const timer = setTimeout(() => backend.kill('SIGKILL'), 1500);
    await exited; clearTimeout(timer);
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  const directory = join(root, '.artifacts/test-stability'); await mkdir(directory, { recursive: true });
  const cases = records.map(row => `<testcase name="${escape(row.name)}" time="${row.seconds.toFixed(6)}">${row.failure ? `<failure>${escape(row.failure)}</failure>` : ''}</testcase>`).join('');
  await writeFile(join(directory, 'ui.junit.xml'), `<testsuite name="real-http-client-ui" tests="${records.length}" failures="${records.filter(r => r.failure).length}">${cases}</testsuite>`);
  await writeFile(join(directory, 'ui.html'), `<!doctype html><meta charset="utf-8"><title>Real HTTP Client UI tests</title><table>${records.map(r => `<tr><td>${escape(r.name)}</td><td>${r.seconds.toFixed(3)}s</td><td>${r.failure ? escape(r.failure) : 'PASS'}</td></tr>`).join('')}</table>`);
  console.log(JSON.stringify(records, null, 2));
});
