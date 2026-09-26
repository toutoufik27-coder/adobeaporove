/* Runs the vectorizer off the main thread so the page stays responsive. */
importScripts('engine.js?v=20');

self.onmessage = function (e) {
  const { id, rgba, width, height, options } = e.data;
  try {
    const t0 = performance.now();
    const result = self.VectorizerEngine.vectorize(rgba, width, height, options, function (p, stage) {
      self.postMessage({ id, type: 'progress', progress: p, stage });
    });
    result.ms = Math.round(performance.now() - t0);
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
