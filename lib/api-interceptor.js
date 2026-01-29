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
  const MAX_CHATGPT_MESSAGES_PER_CHUNK = 250;
  const MAX_CHATGPT_MSG_CHARS = 30_000; // per-message cap in page context to avoid huge postMessage payloads
  const MAX_OPENAI_COMPAT_MSGS = 5000;
  const MAX_OPENAI_COMPAT_TOTAL_CHARS = 2_000_000;

  const safeJsonParse = (text) => {
    try {
      if (!text || typeof text !== 'string') return null;
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  };

  const currentProvider = () => {
    const h = (location.hostname || '').toLowerCase();
    if (h.includes('www.perplexity.ai') || h.endsWith('perplexity.ai')) return 'perplexity';
    if (h.includes('copilot.microsoft.com')) return 'copilot';
    if (h.includes('chatgpt.com') || h.includes('chat.openai.com')) return 'chatgpt';
    if (h.includes('claude.ai')) return 'claude';
    if (h.includes('gemini.google.com') || h.includes('bard.google.com') || h === 'g.co') return 'gemini';
    return 'unknown';
  };

  const isAllowedCrossOriginHost = (host) => {
    const h = String(host || '').toLowerCase();
    return h === 'api.perplexity.ai' || h === 'api.githubcopilot.com' || h.endsWith('.githubcopilot.com');
  };

  const isPerplexityThreadUrl = (url) => {
    try {
      const u = new URL(url);
      if (u.origin !== location.origin) return false;
      // Perplexity UI loads thread history via this endpoint:
      // GET https://www.perplexity.ai/rest/thread/<slug>?...
      return u.pathname.startsWith('/rest/thread/');
    } catch (_) {
      const s = String(url || '');
      return s.startsWith('/rest/thread/') || s.includes('/rest/thread/');
    }
  };

  const isOpenAiCompatChatCompletionsUrl = (url) => {
    try {
      const u = new URL(url);
      const host = (u.hostname || '').toLowerCase();
      if (!u.pathname.includes('/chat/completions')) return false;
      // Perplexity/Copilot may call either:
      // - cross-origin: https://api.perplexity.ai/chat/completions
      // - same-origin proxy: https://www.perplexity.ai/chat/completions (or /api/chat/completions)
      const sameOrigin = u.origin === location.origin;
      if (sameOrigin) return true;
      return host === 'api.perplexity.ai' || host === 'api.githubcopilot.com' || host.endsWith('.githubcopilot.com');
    } catch (_) {
      const s = String(url || '');
      if (!s.includes('/chat/completions')) return false;
      return s.includes('api.perplexity.ai') || s.includes('githubcopilot.com') || s.startsWith('/chat/completions') || s.startsWith('/api/chat/completions');
    }
  };

  const shouldCaptureUrl = (url) => {
    if (!url) return false;
    // Claude typically uses /api/ for convo loading/streaming.
    // ChatGPT typically uses /backend-api/ for conversation fetch/stream.
    // Gemini/Bard often uses /batchexecute or /_/BardChatUi/ style endpoints.
    // We keep this broad but same-origin.
    try {
      const u = new URL(url);

      // Allow same-origin always.
      const sameOrigin = u.origin === location.origin;

      // ChatGPT sometimes uses a cross-origin gateway (still first-party).
      // If the page can fetch it (CORS allowed), we can observe it here.
      const host = (u.hostname || '').toLowerCase();
      const isOpenAiGateway =
        host.endsWith('.api.openai.com') ||
        host.includes('chat.gateway.unified') ||
        host.includes('chat-gateway') ||
        host.includes('gateway.unified');

      // Perplexity/Copilot web UIs use cross-origin OpenAI-like endpoints.
      const isAllowedCrossOrigin = isAllowedCrossOriginHost(host);

      if (!sameOrigin && !isOpenAiGateway && !isAllowedCrossOrigin) return false;

      return (
        isPerplexityThreadUrl(url) ||
        u.pathname.includes('/api/') ||
        u.pathname.includes('/backend-api/') ||
        u.pathname.includes('/batchexecute') ||
        u.pathname.includes('/_/BardChatUi/') ||
        isOpenAiCompatChatCompletionsUrl(url)
      );
    } catch (_) {
      // Fallback for non-absolute URLs
      return (
        isPerplexityThreadUrl(url) ||
        url.includes('/api/') ||
        url.includes('/backend-api/') ||
        url.includes('/batchexecute') ||
        url.includes('/_/BardChatUi/') ||
        isOpenAiCompatChatCompletionsUrl(url)
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
        // Never broadcast across origins. We only talk to the same page origin.
        location.origin
      );
    } catch (_) {
      // ignore
    }
  };

  const isChatGPT = () => {
    const h = (location.hostname || '').toLowerCase();
    return h.includes('chatgpt.com') || h.includes('chat.openai.com');
  };

  const isChatGPTConversationUrl = (url) => {
    try {
      const u = new URL(url);
      return isChatGPT() && u.origin === location.origin && u.pathname.startsWith('/backend-api/conversation/');
    } catch (_) {
      return isChatGPT() && String(url || '').includes('/backend-api/conversation/');
    }
  };

  const normalizePartText = (p) => {
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') {
      if (typeof p.text === 'string') return p.text;
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (typeof p.content === 'string') return p.content;
    }
    return '';
  };

  const extractChatGPTConversationMessages = (json) => {
    const out = [];
    const mapping = json && typeof json === 'object' ? json.mapping : null;
    if (!mapping || typeof mapping !== 'object') return out;

    const currentNode =
      (typeof json.current_node === 'string' && json.current_node) ||
      (typeof json.currentNode === 'string' && json.currentNode) ||
      '';

    const chainIds = [];
    if (currentNode && mapping[currentNode]) {
      let cur = currentNode;
      const guard = new Set();
      while (cur && mapping[cur] && !guard.has(cur) && chainIds.length < 100_000) {
        guard.add(cur);
        chainIds.push(cur);
        cur = mapping[cur] && typeof mapping[cur] === 'object' ? mapping[cur].parent : null;
      }
      chainIds.reverse();
    }

    const idsToUse = chainIds.length ? chainIds : Object.keys(mapping);
    for (const id of idsToUse) {
      const node = mapping[id];
      const msg = node && typeof node === 'object' ? node.message : null;
      if (!msg || typeof msg !== 'object') continue;
      const role = msg.author && typeof msg.author === 'object' ? msg.author.role : null;
      if (role !== 'user' && role !== 'assistant') continue;

      const content = msg.content && typeof msg.content === 'object' ? msg.content : null;
      const ctype = content && typeof content.content_type === 'string' ? content.content_type : '';
      if (ctype === 'user_editable_context') continue;
      const md = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : null;
      if (md && md.is_visually_hidden_from_conversation) continue;

      let text = '';
      if (content && Array.isArray(content.parts)) {
        text = content.parts.map(normalizePartText).filter(Boolean).join('\n').trim();
      }
      if (!text) continue;
      if (text.length > MAX_CHATGPT_MSG_CHARS) {
        text = text.slice(0, MAX_CHATGPT_MSG_CHARS) + '\n[RL4_TRUNCATED_MESSAGE]';
      }

      out.push({
        role,
        content: text,
        // keep numeric create_time (seconds) to reduce payload size; content.js will iso-normalize.
        timestamp: typeof msg.create_time === 'number' ? msg.create_time : null
      });
    }
    return out;
  };

  const postChatGPTConversationChunks = (meta, messages) => {
    const total = Array.isArray(messages) ? messages.length : 0;
    if (!total) return;
    const totalChunks = Math.ceil(total / MAX_CHATGPT_MESSAGES_PER_CHUNK);
    for (let i = 0; i < total; i += MAX_CHATGPT_MESSAGES_PER_CHUNK) {
      const chunkIndex = Math.floor(i / MAX_CHATGPT_MESSAGES_PER_CHUNK);
      post({
        ...meta,
        kind: 'chatgpt_conversation_chunk',
        chunkIndex,
        totalChunks,
        totalMessages: total,
        messages: messages.slice(i, i + MAX_CHATGPT_MESSAGES_PER_CHUNK),
        capturedAt: Date.now()
      });
    }
  };

  const safeTruncateStream = (text) => {
    if (typeof text !== 'string') return '';
    if (text.length <= MAX_SSE_CHARS) return text;
    return text.slice(0, MAX_SSE_CHARS) + '\n[RL4_TRUNCATED_SSE]';
  };

  const extractOpenAiCompatRequestMessages = (bodyJson) => {
    const raw = Array.isArray(bodyJson && bodyJson.messages) ? bodyJson.messages : [];
    const out = [];
    let total = 0;

    for (const m of raw) {
      const role = m && (m.role === 'user' || m.role === 'assistant') ? m.role : null;
      const content = m && typeof m.content === 'string' ? m.content.trim() : '';
      if (!role || !content) continue;
      total += content.length;
      out.push({ role, content });
      if (out.length >= MAX_OPENAI_COMPAT_MSGS || total >= MAX_OPENAI_COMPAT_TOTAL_CHARS) break;
    }

    // If truncated, keep the most recent tail (likely most relevant).
    if (raw.length > out.length || total >= MAX_OPENAI_COMPAT_TOTAL_CHARS) {
      const tail = out.slice(-Math.min(out.length, 1200));
      return tail;
    }

    return out;
  };

  const extractOpenAiCompatAssistantFromJson = (json) => {
    // Non-streaming OpenAI chat completions
    try {
      const choices = Array.isArray(json && json.choices) ? json.choices : [];
      const out = [];
      for (const ch of choices) {
        const msg = ch && typeof ch === 'object' ? ch.message : null;
        const role = msg && msg.role === 'assistant' ? 'assistant' : null;
        const content = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
        if (!role || !content) continue;
        out.push({ role, content });
      }
      return out;
    } catch (_) {
      return [];
    }
  };

  async function readOpenAiCompatSSE(clone, meta) {
    // Aggregate OpenAI-style streaming deltas into one assistant message.
    let reader = null;
    try {
      if (!clone.body || !clone.body.getReader) return;
      reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let total = 0;
      const start = Date.now();
      let text = '';
      let done = false;

      while (!done && Date.now() - start < MAX_SSE_MS && total < MAX_SSE_CHARS) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        const chunk = decoder.decode(value, { stream: true });
        total += chunk.length;
        buf += chunk;

        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const l = line.trimEnd();
          if (!l.startsWith('data:')) continue;
          const data = l.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          const json = safeJsonParse(data);
          if (!json) continue;
          const choice = Array.isArray(json.choices) ? json.choices[0] : null;
          if (!choice || typeof choice !== 'object') continue;
          const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : null;
          const content = delta && typeof delta.content === 'string' ? delta.content : '';
          if (content) text += content;
          if (choice.finish_reason === 'stop') done = true;
        }
      }

      const finalText = String(text || '').trim();
      if (!finalText) return;
      post({
        ...meta,
        kind: 'openai_compat_chat_completions',
        provider: String(meta && meta.provider ? meta.provider : currentProvider()),
        assistant_messages: [{ role: 'assistant', content: finalText }],
        capturedAt: Date.now()
      });
    } catch (_) {
      // ignore
    } finally {
      // Ensure the stream reader is released even on timeouts/errors.
      if (reader) {
        try {
          await reader.cancel();
        } catch (_) {
          // ignore
        }
      }
    }
  }

  async function readSSE(clone, meta) {
    let reader = null;
    try {
      if (!clone.body || !clone.body.getReader) return;
      reader = clone.body.getReader();
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
    } finally {
      // Ensure the stream reader is released even on timeouts/errors.
      if (reader) {
        try {
          await reader.cancel();
        } catch (_) {
          // ignore
        }
      }
    }
  }

  const extractPerplexityThreadMessages = (json) => {
    // Minimal transcript from GET /rest/thread/<slug>
    // - user: entry.query_str
    // - assistant: best-effort text extracted from entry.blocks
    const out = [];
    const entries = json && typeof json === 'object' && Array.isArray(json.entries) ? json.entries : [];
    if (!entries.length) return out;

    const seen = new Set();
    const sig = (role, content) => `${role}::${String(content || '').slice(0, 200)}`;

    const extractTextDeep = (node, depth, budget, parts) => {
      if (!node || depth > 8 || budget.remaining <= 0) return;
      if (typeof node === 'string') {
        const s = node.trim();
        if (!s) return;
        if (/^https?:\/\//i.test(s) && s.length < 300) return;
        const take = s.slice(0, budget.remaining);
        budget.remaining -= take.length;
        parts.push(take);
        return;
      }
      if (typeof node === 'number' || typeof node === 'boolean') return;
      if (Array.isArray(node)) {
        for (const item of node) extractTextDeep(item, depth + 1, budget, parts);
        return;
      }
      if (typeof node === 'object') {
        const preferredKeys = ['answer', 'content', 'text', 'markdown', 'response', 'final', 'message'];
        for (const k of preferredKeys) {
          if (budget.remaining <= 0) break;
          if (Object.prototype.hasOwnProperty.call(node, k)) extractTextDeep(node[k], depth + 1, budget, parts);
        }
        for (const k of Object.keys(node)) {
          if (budget.remaining <= 0) break;
          if (preferredKeys.includes(k)) continue;
          if (
            k.includes('uuid') ||
            k.includes('token') ||
            k.includes('image') ||
            k.includes('url') ||
            k.includes('sources') ||
            k.includes('search') ||
            k.includes('citation') ||
            k.includes('reference')
          ) {
            continue;
          }
          extractTextDeep(node[k], depth + 1, budget, parts);
        }
      }
    };

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      const q = typeof entry.query_str === 'string' ? entry.query_str.trim() : '';
      if (q) {
        const s = sig('user', q);
        if (!seen.has(s)) {
          seen.add(s);
          out.push({ role: 'user', content: q, timestamp: null });
        }
      }

      const blocks = Array.isArray(entry.blocks) ? entry.blocks : [];
      if (blocks.length) {
        const budget = { remaining: 50_000 };
        const parts = [];
        const preferred = [];
        const fallback = [];
        for (const b of blocks) {
          const iu = b && typeof b === 'object' && typeof b.intended_usage === 'string' ? b.intended_usage : '';
          if (iu === 'final' || iu === 'answer') preferred.push(b);
          else fallback.push(b);
        }
        const ordered = preferred.length ? preferred.concat(fallback) : blocks;
        extractTextDeep(ordered, 0, budget, parts);
        const a = parts.join('\n').trim();
        if (a) {
          const clipped =
            a.length > MAX_CHATGPT_MSG_CHARS ? a.slice(0, MAX_CHATGPT_MSG_CHARS) + '\n[RL4_TRUNCATED_MESSAGE]' : a;
          const s = sig('assistant', clipped);
          if (!seen.has(s)) {
            seen.add(s);
            out.push({ role: 'assistant', content: clipped, timestamp: null });
          }
        }
      }
    }

    return out;
  };

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

      // Perplexity history (thread): GET /rest/thread/<slug> returns entries[] with blocks.
      if (
        isPerplexityThreadUrl(url) &&
        String(method || '').toUpperCase() === 'GET' &&
        clone.status === 200 &&
        contentType.includes('application/json')
      ) {
        try {
          const json = await clone.json();
          const messages = extractPerplexityThreadMessages(json);
          if (messages && messages.length) {
            post({
              via: 'fetch_perplexity_thread',
              url,
              method: String(method || 'GET').toUpperCase(),
              status: clone.status,
              contentType,
              kind: 'perplexity_thread',
              provider: 'perplexity',
              messages,
              capturedAt: Date.now()
            });
            return res;
          }
        } catch (_) {
          // fall through to generic capture below
        }
      }

      // OpenAI-compatible /chat/completions (Perplexity / Copilot): capture request.messages + response.
      // NOTE: never capture request headers (may include auth tokens).
      const isOpenAiCompat = isOpenAiCompatChatCompletionsUrl(url) && String(method || '').toUpperCase() === 'POST';
      let openaiRequestMessages = [];
      let openaiRequestMeta = {};
      if (isOpenAiCompat) {
        const bodyRaw = init && typeof init.body === 'string' ? init.body : '';
        const bodyJson = safeJsonParse(bodyRaw);
        openaiRequestMessages = extractOpenAiCompatRequestMessages(bodyJson);
        openaiRequestMeta = {
          provider: currentProvider(),
          model: bodyJson && typeof bodyJson.model === 'string' ? bodyJson.model : '',
          stream: !!(bodyJson && bodyJson.stream)
        };
      }

      // ChatGPT conversation JSON can be huge; avoid truncating the raw body.
      // Instead, parse JSON in page context and stream only the extracted messages to the extension.
      if (
        isChatGPTConversationUrl(url) &&
        clone.status === 200 &&
        contentType.includes('application/json')
      ) {
        try {
          const json = await clone.json();
          const messages = extractChatGPTConversationMessages(json);
          if (messages && messages.length) {
            postChatGPTConversationChunks(
              {
                via: 'fetch_chatgpt_conversation',
                url,
                method: String(method || 'GET').toUpperCase(),
                status: clone.status,
                contentType
              },
              messages
            );
          } else {
            post({
              via: 'fetch_chatgpt_conversation',
              url,
              method: String(method || 'GET').toUpperCase(),
              status: clone.status,
              contentType,
              kind: 'chatgpt_conversation_empty',
              capturedAt: Date.now()
            });
          }
        } catch (_) {
          // If parsing fails, fallback to generic capture below (may truncate).
        }
        return res;
      }

      // ChatGPT streams as text/event-stream; capture SSE frames (bounded).
      if (contentType.includes('text/event-stream')) {
        if (isOpenAiCompat) {
          // Aggregate OpenAI-like stream into one assistant message + attach request history.
          readOpenAiCompatSSE(clone, {
            url,
            method: String(method || 'GET').toUpperCase(),
            status: clone.status,
            contentType,
            request_messages: openaiRequestMessages,
            request_meta: openaiRequestMeta,
            provider: openaiRequestMeta.provider
          });
          return res;
        }
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

      // OpenAI-compatible non-stream: prefer JSON parse and post a normalized event.
      if (isOpenAiCompat && clone.status === 200 && contentType.includes('application/json')) {
        const json = await clone.json();
        const assistant_messages = extractOpenAiCompatAssistantFromJson(json);
        post({
          via: 'fetch_openai_compat',
          url,
          method: String(method || 'GET').toUpperCase(),
          status: clone.status,
          contentType,
          kind: 'openai_compat_chat_completions',
          provider: openaiRequestMeta.provider,
          request_messages: openaiRequestMessages,
          assistant_messages,
          response_meta: {
            id: json && typeof json.id === 'string' ? json.id : '',
            model: json && typeof json.model === 'string' ? json.model : openaiRequestMeta.model,
            created: json && typeof json.created === 'number' ? json.created : null,
            usage: json && typeof json.usage === 'object' ? json.usage : null
          },
          capturedAt: Date.now()
        });
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

  // Allow content script to request a page-context fetch (more reliable than content-script fetch for ChatGPT).
  window.addEventListener('message', async (event) => {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== 'RL4_API_REQUEST') return;
      const payload = data.payload || {};
      if (!payload || typeof payload.action !== 'string') return;

      // A) ChatGPT conversation fetch (page context)
      if (payload.action === 'fetch_chatgpt_conversation') {
        if (!isChatGPT()) return;
        const convId = String(payload.conversationId || '').trim();
        if (!convId) return;

        const url = `${location.origin}/backend-api/conversation/${encodeURIComponent(convId)}`;
        const res = await originalFetch(url, { credentials: 'include' });
        const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        if (!res.ok || !contentType.includes('application/json')) {
          post({
            via: 'page_fetch_request',
            url,
            method: 'GET',
            status: res.status,
            contentType,
            kind: 'chatgpt_conversation_fetch_failed',
            capturedAt: Date.now()
          });
          return;
        }

        const json = await res.json();
        const messages = extractChatGPTConversationMessages(json);
        postChatGPTConversationChunks(
          {
            via: 'page_fetch_request',
            url,
            method: 'GET',
            status: res.status,
            contentType
          },
          messages
        );
        return;
      }

      // B) Perplexity thread history fetch (page context)
      if (payload.action === 'fetch_perplexity_thread') {
        if (currentProvider() !== 'perplexity') return;
        const slug = String(payload.threadSlug || payload.slug || '').trim();
        if (!slug) return;

        // Best-effort query params; server tolerates missing optional params.
        const qs =
          typeof payload.queryString === 'string' && payload.queryString.trim()
            ? payload.queryString.trim()
            : '?with_parent_info=true&with_schematized_response=true&source=default&limit=50&offset=0&from_first=true';

        const url = `${location.origin}/rest/thread/${encodeURIComponent(slug)}${qs.startsWith('?') ? qs : `?${qs}`}`;
        const headers = {
          accept: '*/*',
          'x-app-apiclient': 'default'
        };
        const res = await originalFetch(url, { method: 'GET', credentials: 'include', headers });
        const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        if (!res.ok || !contentType.includes('application/json')) return;

        const json = await res.json();
        const messages = extractPerplexityThreadMessages(json);
        if (!messages || !messages.length) return;
        post({
          via: 'page_fetch_perplexity_thread',
          url,
          method: 'GET',
          status: res.status,
          contentType,
          kind: 'perplexity_thread',
          provider: 'perplexity',
          messages,
          capturedAt: Date.now()
        });
        return;
      }
    } catch (_) {
      // ignore
    }
  });

  const providerFromUrl = (url) => {
    try {
      const u = new URL(url);
      const host = (u.hostname || '').toLowerCase();
      if (host.includes('githubcopilot.com')) return 'copilot';
      if (host.includes('perplexity.ai')) return 'perplexity';
      // Same-origin proxy case: fall back to current provider.
      return currentProvider();
    } catch (_) {
      return currentProvider();
    }
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
      const method = this.__rl4_method || 'GET';
      const isOpenAiCompat = isOpenAiCompatChatCompletionsUrl(url) && method === 'POST';

      // Capture request.messages when available (best effort; never capture headers).
      if (isOpenAiCompat) {
        try {
          const bodyRaw = typeof args[0] === 'string' ? args[0] : '';
          const bodyJson = safeJsonParse(bodyRaw);
          this.__rl4_openai_req_messages = extractOpenAiCompatRequestMessages(bodyJson);
          this.__rl4_openai_req_meta = {
            provider: providerFromUrl(url),
            model: bodyJson && typeof bodyJson.model === 'string' ? bodyJson.model : '',
            stream: !!(bodyJson && bodyJson.stream)
          };
        } catch (_) {
          this.__rl4_openai_req_messages = [];
          this.__rl4_openai_req_meta = { provider: providerFromUrl(url), model: '', stream: false };
        }
      }

      if (shouldCaptureUrl(url)) {
        this.addEventListener('load', () => {
          try {
            const contentType = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
            if (contentType && contentType.includes('text/event-stream')) return;
            // Perplexity history (thread): GET /rest/thread/<slug>
            if (isPerplexityThreadUrl(url) && method === 'GET' && this.status === 200 && contentType.includes('application/json')) {
              const json = safeJsonParse(String(this.responseText || ''));
              const messages = json ? extractPerplexityThreadMessages(json) : [];
              if (messages && messages.length) {
                post({
                  via: 'xhr_perplexity_thread',
                  url,
                  method,
                  status: this.status,
                  contentType,
                  kind: 'perplexity_thread',
                  provider: 'perplexity',
                  messages,
                  capturedAt: Date.now()
                });
                return;
              }
            }
            // OpenAI-compatible non-stream response: emit normalized event including request history when we have it.
            if (isOpenAiCompat && this.status === 200 && contentType.includes('application/json')) {
              const json = safeJsonParse(String(this.responseText || ''));
              const assistant_messages = json ? extractOpenAiCompatAssistantFromJson(json) : [];
              post({
                via: 'xhr_openai_compat',
                url,
                method,
                status: this.status,
                contentType,
                kind: 'openai_compat_chat_completions',
                provider: (this.__rl4_openai_req_meta && this.__rl4_openai_req_meta.provider) || providerFromUrl(url),
                request_messages: Array.isArray(this.__rl4_openai_req_messages) ? this.__rl4_openai_req_messages : [],
                assistant_messages,
                response_meta: json
                  ? {
                      id: typeof json.id === 'string' ? json.id : '',
                      model: typeof json.model === 'string' ? json.model : ((this.__rl4_openai_req_meta && this.__rl4_openai_req_meta.model) || ''),
                      created: typeof json.created === 'number' ? json.created : null,
                      usage: typeof json.usage === 'object' ? json.usage : null
                    }
                  : { id: '', model: '', created: null, usage: null },
                capturedAt: Date.now()
              });
              return;
            }

            const body = safeTruncate(String(this.responseText || ''));
            post({
              via: 'xhr',
              url,
              method,
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


