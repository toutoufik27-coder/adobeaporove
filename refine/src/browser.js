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

// Longest wait for one DevTools command (a render of a very large SVG included).
const COMMAND_MS = +(process.env.SVG_REFINE_BROWSER_TIMEOUT || 60000);

// One browser per process; pages are reused. A failed launch is remembered with its
// reason (it is not retried on every call, and "unavailable" is never silent).
let shared = null, failure = null;
export async function getBrowser() {
  if (shared) return shared;
  if (failure) return null;
  const exe = findBrowser();
  if (!exe) { failure = 'no Chrome / Edge found (set SVG_REFINE_BROWSER)'; return null; }
  if (typeof WebSocket === 'undefined') { failure = 'this Node has no built-in WebSocket (Node 22+ needed)'; return null; }
  try { shared = await launch(exe); } catch (err) { failure = `${exe}: ${err.message || err}`; }
  return shared;
}
// { available, exe, reason }: what the last getBrowser() found
export const browserStatus = () => ({ available: !!shared, exe: shared ? shared.exe : null, reason: shared ? null : failure });
export async function closeBrowser() { if (shared) { const b = shared; shared = null; await b.close(); } failure = null; }

async function launch(exe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-refine-'));
  // Chrome refuses to start as root with its sandbox on (containers, CI): only then is
  // it turned off. The page is an <img> of the SVG, so no script runs either way.
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--font-render-hinting=none', ...(asRoot ? ['--no-sandbox'] : []), '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '', done = false;
    const t = setTimeout(() => rej(new Error('browser did not start')), 20000);
    // only the start-up output is kept (the browser keeps writing to stderr)
    proc.stderr.on('data', (d) => { if (done) return; buf = (buf + d).slice(-8192); const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { done = true; clearTimeout(t); res(m[1]); } });
    proc.on('exit', (code) => { clearTimeout(t); if (!done) rej(new Error(`browser exited (${code}): ${buf.trim().split('\n').pop().slice(0, 200)}`)); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools connection failed')); });
  let id = 0, dead = null;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  // a browser that dies or stops answering fails every waiting call (it never hangs)
  const die = (why) => { if (dead) return; dead = why; for (const p of pending.values()) { clearTimeout(p.t); p.rej(new Error(why)); } pending.clear(); if (shared && shared.proc === proc) { shared = null; failure = why; } };
  ws.onclose = () => die('the browser connection closed');
  proc.on('exit', (code) => die(`the browser exited (${code})`));
  const send = (method, params = {}, sessionId, ms = COMMAND_MS) => new Promise((res, rej) => {
    if (dead) { rej(new Error(dead)); return; }
    const i = ++id, t = setTimeout(() => { pending.delete(i); rej(new Error(`${method}: no answer from the browser in ${ms / 1000} s`)); }, ms);
    pending.set(i, { res, rej, t });
    try { ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (err) { clearTimeout(t); pending.delete(i); rej(err); }
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable');
  const { frameTree } = await s('Page.getFrameTree');
  const frameId = frameTree.frame.id;
  let queue = Promise.resolve();

  // RGB Float32 image (0..255) of the SVG drawn at width x height CSS pixels over white.
  // Renders run one at a time; a failed render fails only its own caller (the queue
  // itself never stays rejected, so one bad file cannot fail every later one).
  const render = (svgText, width, height) => {
    const job = queue.then(() => renderNow(svgText, width, height));
    queue = job.catch(() => {});
    return job;
  };
  const renderNow = async (svgText, width, height) => {
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
  };
  const close = async () => {
    if (!dead) try { await send('Browser.close', {}, undefined, 5000); } catch {}
    try { ws.close(); } catch {}
    await new Promise((res) => setTimeout(res, 300));
    try { proc.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return { render, close, exe, proc };
}
