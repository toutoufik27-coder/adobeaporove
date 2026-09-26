// Browser oracle (Node only): renders an SVG exactly as a web page shows it in an
// <img>, with headless Chrome / Edge over the DevTools protocol. No npm dependency:
// Node's built-in WebSocket speaks to the browser. This render is the source of truth
// for visual validation (text, images, filters, patterns included).
// In <img> mode the browser runs no script and loads nothing external.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { decodePNG } from './png.js';

const CANDIDATES = [
  process.env.SVG_REFINE_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
export const findBrowser = () => CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

// One browser per process; pages are reused.
let shared = null;
export async function getBrowser() {
  if (shared) return shared;
  const exe = findBrowser();
  if (!exe || typeof WebSocket === 'undefined') return null;
  shared = await launch(exe).catch(() => null);
  return shared;
}
export async function closeBrowser() { if (shared) { const b = shared; shared = null; await b.close(); } }

async function launch(exe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-refine-'));
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--font-render-hinting=none', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('browser did not start')), 20000);
    proc.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(t); res(m[1]); } });
    proc.on('exit', () => { clearTimeout(t); rej(new Error('browser exited')); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map(), events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method) for (const w of events.splice(0)) if (!w(m)) events.push(w);
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable');
  const { frameTree } = await s('Page.getFrameTree');
  const frameId = frameTree.frame.id;
  let queue = Promise.resolve();

  // RGB Float32 image (0..255) of the SVG drawn at width x height CSS pixels over white
  const render = (svgText, width, height) => (queue = queue.then(async () => {
    const W = Math.max(1, Math.round(width)), H = Math.max(1, Math.round(height));
    await s('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    const src = 'data:image/svg+xml;base64,' + Buffer.from(svgText, 'utf8').toString('base64');
    const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}img{display:block}</style></head><body><img id="i" width="${W}" height="${H}" src="${src}"></body></html>`;
    await s('Page.setDocumentContent', { frameId, html });
    const r = await s('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `new Promise((ok) => { const i = document.getElementById('i'); const done = () => (i.decode ? i.decode().then(() => ok(i.naturalWidth > 0 ? 1 : -1), () => ok(-1)) : ok(1)); if (i.complete) done(); else { i.onload = done; i.onerror = () => ok(-1); } }).then((v) => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(v)))))` });
    if (r.result.value !== 1) throw new Error('the browser could not display this SVG');
    const shot = await s('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 }, captureBeyondViewport: false, fromSurface: true });
    const png = decodePNG(Buffer.from(shot.data, 'base64'));
    const img = new Float32Array(W * H * 3);
    for (let p = 0; p < W * H; p++) { const a = png.data[p * 4 + 3] / 255; for (let c = 0; c < 3; c++) img[p * 3 + c] = png.data[p * 4 + c] * a + 255 * (1 - a); }
    return { img, W, H };
  }));
  const close = async () => { try { await send('Browser.close'); } catch {} try { ws.close(); } catch {} setTimeout(() => { try { proc.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 300); };
  return { render, close, exe };
}
