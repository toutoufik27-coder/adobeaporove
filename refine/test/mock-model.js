// A stand-in for a local model server, for tests only (speaks the Ollama and the
// OpenAI-compatible protocols). It answers like a vision model would for a clock:
// ring groups of 10-16 marks are hour marks (12), other groups have no fixed count.
import http from 'http';

export function startMockModel(port = 11999) {
  const answer = (prompt) => {
    const groups = [...prompt.matchAll(/Group (\d+): (\d+) similar marks arranged in (a circle|a row)?/g)].map((m) => {
      const n = +m[2], ring = /circle/.test(m[0]);
      return ring && n >= 10 && n <= 16 ? { id: +m[1], meaning: 'clock hour marks', expected_count: 12, confidence: 0.92 } : { id: +m[1], meaning: 'decoration', expected_count: null, confidence: 0.6 };
    });
    return JSON.stringify({ object: 'clock', groups });
  };
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, cors);
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock-vision:latest' }] }));
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'mock-vision' }] }));
      const j = JSON.parse(body || '{}');
      const msg = j.messages[0];
      const prompt = typeof msg.content === 'string' ? msg.content : msg.content.find((c) => c.type === 'text').text;
      const hasImage = (msg.images && msg.images[0] && msg.images[0].length > 100) || (Array.isArray(msg.content) && msg.content.some((c) => c.type === 'image_url'));
      const text = hasImage ? answer(prompt) : '{"object":"no image","groups":[]}';
      if (req.url === '/api/chat') return res.end(JSON.stringify({ message: { role: 'assistant', content: text } }));
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    });
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}
if (import.meta.url === `file://${process.argv[1]}`) startMockModel(+process.argv[2] || 11999).then(() => console.log('mock model on', process.argv[2] || 11999));
