// Local vision model client (runs on the user's machine; nothing leaves it).
// - Ollama:        http://localhost:11434   (POST /api/chat, GET /api/tags)
// - OpenAI-style:  LM Studio http://localhost:1234, llama.cpp server, Jan, vLLM
//                  (POST /v1/chat/completions, GET /v1/models)
// Works in the browser (page or worker) and in Node 18+ (global fetch).

export const PROVIDERS = {
  ollama: { label: 'Ollama', url: 'http://localhost:11434' },
  openai: { label: 'LM Studio / llama.cpp / OpenAI-compatible', url: 'http://localhost:1234' },
};

async function http(url, body, timeoutMs) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal } : { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`no answer after ${Math.round(timeoutMs / 1000)} s`);
    if (e instanceof TypeError) throw new Error(`cannot reach ${url} — is the model server running, and does it allow this page (CORS)?`);
    throw e;
  } finally { clearTimeout(t); }
}

export async function listModels(cfg) {
  const base = cfg.url.replace(/\/+$/, '');
  if (cfg.provider === 'ollama') { const r = await http(base + '/api/tags', null, 8000); return (r.models || []).map((m) => m.name); }
  const r = await http(base + '/v1/models', null, 8000);
  return (r.data || []).map((m) => m.id);
}

// Ask about one image. Returns the parsed JSON answer and the raw text.
export async function askVision(cfg, prompt, pngBase64, schema) {
  const base = cfg.url.replace(/\/+$/, ''), timeout = cfg.timeoutMs || 180000;
  let text;
  if (cfg.provider === 'ollama') {
    const r = await http(base + '/api/chat', {
      model: cfg.model, stream: false, format: schema || 'json', options: { temperature: 0 },
      messages: [{ role: 'user', content: prompt, images: [pngBase64] }],
    }, timeout);
    text = r.message && r.message.content;
  } else {
    const r = await http(base + '/v1/chat/completions', {
      model: cfg.model, temperature: 0, max_tokens: 800,
      ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } } } : {}),
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + pngBase64 } }] }],
    }, timeout);
    text = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
  }
  return { answer: parseJSON(text), raw: text };
}

// Small models sometimes wrap JSON in prose or code fences.
export function parseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    groups: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, meaning: { type: 'string' }, expected_count: { type: ['integer', 'null'] }, confidence: { type: 'number' } }, required: ['id', 'meaning', 'expected_count'] } },
  },
  required: ['object', 'groups'],
};
