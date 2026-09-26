// The web page, end to end, in a real browser: load the deer icon into index.html, run
// the professional mode, and wait for the page's own browser check. The page must
// compare the output with the corrected drawing (not with the original, which the
// recolour of the corner piece differs from on purpose) and confirm the intended change
// itself. Needs Chrome / Edge; files are served by a small static server (the page loads
// ES modules and a module worker, which file:// does not allow).
//   node test/page.js            (or from test/run.js when a browser is available)
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { findBrowser } from '../src/browser.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

export async function pageTest(ok, skip) {
  const exe = findBrowser();
  if (!exe) return skip('the web page end to end (no browser)', 4);
  const server = await serve(), port = server.address().port;
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'refine-page-'));
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const proc = spawn(exe, ['--headless=new', ...(asRoot ? ['--no-sandbox'] : []), '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const errors = [];
  let ws = null;
  try {
    const wsUrl = await new Promise((res, rej) => { let b = ''; const t = setTimeout(() => rej(new Error('browser did not start')), 30000); proc.stderr.on('data', (d) => { b += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(b); if (m) { clearTimeout(t); res(m[1]); } }); });
    ws = new WebSocket(wsUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pend = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    };
    const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    const ev = async (expression) => { const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result.result.value; };
    const until = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
    await s('Runtime.enable');
    await s('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await s('Page.navigate', { url: `http://127.0.0.1:${port}/refine/` });
    await until('document.readyState === "complete" && !!document.getElementById("file")', 30000);
    await ev(`fetch('/refine/samples/deer-frame-icon.svg').then((r) => r.blob()).then((b) => { const dt = new DataTransfer(); dt.items.add(new File([b], 'deer-frame-icon.svg', { type: 'image/svg+xml' })); const i = document.getElementById('file'); i.files = dt.files; i.dispatchEvent(new Event('change')); return true; })`);
    const recommended = await until('!document.getElementById("recCard").hidden && /احترافية/.test(document.getElementById("recBody").innerText)', 120000);
    const recText = await ev('document.getElementById("recBody").innerText');
    ok(recommended && /جزء متكرر متناظر/.test(recText), `page: the analysis names the odd corner piece and recommends the professional mode (${recText.split('\n')[0].slice(0, 90)})`);
    await ev(`document.querySelector('#modes [data-m="professional"]').click(), true`);
    const done = await until('/التحقق البصري في المتصفح ناجح|لم تجتز التحقق البصري/.test(document.getElementById("integ").innerText)', 180000);
    const integ = await ev('document.getElementById("integ").innerText'), stages = await ev('[...document.querySelectorAll("#stages button b")].map((b) => b.textContent).join(" > ")');
    ok(done && /التحقق البصري في المتصفح ناجح/.test(integ) && /مقارنة بالرسم بعد التصحيح المقصود/.test(integ), `page: its own browser check passes against the corrected drawing (${(/فرق مرئي [\d.]+%/.exec(integ) || ['?'])[0]})`);
    ok(/ظهر في المتصفح في مكانه فقط/.test(integ) && /توحيد الأجزاء المتكررة/.test(stages), `page: the recolour is confirmed in this browser (${(/\((\d+) بكسل تغيّر[^)]*\)/.exec(integ) || ['?'])[0]}); stages ${stages}`);
    ok(!errors.length, `page: no script errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  } catch (err) {
    ok(false, `page: ${err.message}`);
  } finally {
    try { ws && ws.close(); } catch {}
    proc.kill();
    server.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let pass = 0, fail = 0, skipped = 0;
  await pageTest((c, msg) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${msg}`); if (c) pass++; else fail++; }, (msg, n = 1) => { console.log(`SKIP ${msg}`); skipped += n; });
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail ? 1 : 0);
}
