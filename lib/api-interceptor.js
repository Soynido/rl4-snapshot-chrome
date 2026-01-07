/**
 * RL4 API Interceptor (page context)
 * Hooks fetch + XMLHttpRequest to mirror Claude.ai + ChatGPT API responses to the extension.
 *
 * No paid API usage: this only observes requests the page already makes.
 */
(function () {
  if (window.__RL4_API_INTERCEPTOR_INSTALLED__) return;
  window.__RL4_API_INTERCEPTOR_INSTALLED__ = true;

  const MAX_BODY_CHARS = 800_000; // cap to avoid huge memory usage
  const MAX_SSE_CHARS = 600_000; // cap streaming capture (ChatGPT)
  const MAX_SSE_MS = 10_000; // stop reading after 10s to avoid infinite streams

  const shouldCaptureUrl = (url) => {
    if (!url) return false;
    // Claude typically uses /api/ for convo loading/streaming.
    // ChatGPT typically uses /backend-api/ for conversation fetch/stream.
    // Gemini/Bard often uses /batchexecute or /_/BardChatUi/ style endpoints.
    // We keep this broad but same-origin.
    try {
      const u = new URL(url);
      if (u.origin !== location.origin) return false;
      return (
        u.pathname.includes('/api/') ||
        u.pathname.includes('/backend-api/') ||
        u.pathname.includes('/batchexecute') ||
        u.pathname.includes('/_/BardChatUi/')
      );
    } catch (_) {
      return (
        url.includes('/api/') ||
        url.includes('/backend-api/') ||
        url.includes('/batchexecute') ||
        url.includes('/_/BardChatUi/')
      );
    }
  };

  const normalizeUrl = (url) => {
    try {
      if (!url) return '';
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
      if (url.startsWith('/')) return `${location.origin}${url}`;
      return url;
    } catch (_) {
      return String(url || '');
    }
  };

  const safeTruncate = (text) => {
    if (typeof text !== 'string') return '';
    if (text.length <= MAX_BODY_CHARS) return text;
    return text.slice(0, MAX_BODY_CHARS) + '\n[RL4_TRUNCATED]';
  };

  const post = (payload) => {
    try {
      window.postMessage(
        {
          type: 'RL4_API_RESPONSE',
          payload
        },
        '*'
      );
    } catch (_) {
      // ignore
    }
  };

  const isChatGPT = () => {
    const h = (location.hostname || '').toLowerCase();
    return h.includes('chatgpt.com') || h.includes('chat.openai.com');
  };

  const safeTruncateStream = (text) => {
    if (typeof text !== 'string') return '';
    if (text.length <= MAX_SSE_CHARS) return text;
    return text.slice(0, MAX_SSE_CHARS) + '\n[RL4_TRUNCATED_SSE]';
  };

  async function readSSE(clone, meta) {
    try {
      if (!clone.body || !clone.body.getReader) return;
      const reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let total = 0;
      const start = Date.now();

      while (Date.now() - start < MAX_SSE_MS && total < MAX_SSE_CHARS) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        total += chunk.length;
        buf += chunk;

        // Process full lines
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const l = line.trimEnd();
          if (!l.startsWith('data:')) continue;
          const data = l.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          // forward each data frame (often JSON)
          post({
            ...meta,
            via: 'fetch_sse',
            body: safeTruncateStream(data),
            capturedAt: Date.now()
          });
        }
      }
    } catch (_) {
      // ignore
    }
  }

  // Hook fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);
    try {
      const input = args[0];
      const init = args[1] || {};
      const rawUrl = typeof input === 'string' ? input : input && input.url ? input.url : '';
      const url = normalizeUrl(rawUrl);
      if (!shouldCaptureUrl(url)) return res;

      const method =
        (init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET';
      const clone = res.clone();
      const contentType = (clone.headers && clone.headers.get && clone.headers.get('content-type')) || '';

      // ChatGPT streams as text/event-stream; capture SSE frames (bounded).
      if (contentType.includes('text/event-stream')) {
        if (isChatGPT() && shouldCaptureUrl(url)) {
          readSSE(clone, {
            url,
            method: String(method || 'GET').toUpperCase(),
            status: clone.status,
            contentType
          });
        }
        return res;
      }

      // Only try to read likely-text bodies.
      if (
        !contentType.includes('application/json') &&
        !contentType.includes('text/') &&
        !contentType.includes('application/graphql')
      ) {
        return res;
      }

      const text = safeTruncate(await clone.text());
      post({
        via: 'fetch',
        url,
        method: String(method || 'GET').toUpperCase(),
        status: clone.status,
        contentType,
        body: text,
        capturedAt: Date.now()
      });
    } catch (_) {
      // ignore
    }
    return res;
  };

  // Hook XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__rl4_url = normalizeUrl(url);
      this.__rl4_method = String(method || 'GET').toUpperCase();
    } catch (_) {
      // ignore
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const url = this.__rl4_url;
      if (shouldCaptureUrl(url)) {
        this.addEventListener('load', () => {
          try {
            const contentType = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
            if (contentType && contentType.includes('text/event-stream')) return;
            const body = safeTruncate(String(this.responseText || ''));
            post({
              via: 'xhr',
              url,
              method: this.__rl4_method || 'GET',
              status: this.status,
              contentType,
              body,
              capturedAt: Date.now()
            });
          } catch (_) {
            // ignore
          }
        });
      }
    } catch (_) {
      // ignore
    }
    return originalSend.apply(this, args);
  };
})();


