/**
 * RL4 Snapshot Extension - Background Service Worker
 * Handles extension lifecycle and optional message routing
 */

const STORAGE_KEYS = {
  LAST_SUPPORTED_TAB: 'rl4_last_supported_tab_v1',
  UI_WINDOW_ID: 'rl4_ui_window_id_v1',
  // Chunked encoder (store small per-conversation notes in chrome.storage)
  CHUNK_NOTES_PREFIX: 'rl4_chunk_notes_v1:'
};

// --- Focused tab tracking (multi-window safe) ---
// In extension popups, tab queries can be unreliable. Track the focused normal window + its active tab
// from the service worker, then let the popup ask for the right target tab deterministically.
let lastFocusedNormalWindowId = null;
const activeTabIdByWindow = new Map(); // windowId -> tabId

// --- Transcript store (IndexedDB in extension origin) ---
function openTranscriptDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rl4_transcripts_v1', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'convKey' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: ['convKey', 'idx'] });
        store.createIndex('byConvKey', 'convKey', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open transcripts IndexedDB'));
  });
}

async function idbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    const store = tx.objectStore(storeName);
    store.put(value);
  });
}

async function idbPutMany(db, storeName, values) {
  const list = Array.isArray(values) ? values : [];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    const store = tx.objectStore(storeName);
    for (const v of list) store.put(v);
  });
}

async function idbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('IndexedDB get failed'));
  });
}

async function idbGetAllByIndex(db, storeName, indexName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const idx = store.index(indexName);
    const req = idx.getAll(key);
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error || new Error('IndexedDB getAll failed'));
  });
}

function encodeMessagesCompact(messages) {
  const SEP = '\n\n<|RL4_MSG|>\n\n';
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role =
      m && String(m.role) === 'user'
        ? 'USER'
        : m && String(m.role) === 'assistant'
          ? 'ASSISTANT'
          : 'UNKNOWN';
    const content = m && m.content ? String(m.content).trim() : '';
    if (!content) continue;
    out.push(`${role}:\n${content}`);
  }
  return out.join(SEP);
}

function buildUniversalEncoderHeader() {
  return (
    `RL4 Conversation Encoder — Universal Prompt\n\n` +
    `You are about to encode our entire conversation into RL4 format, a semantic compression protocol designed for cross-LLM context transport.\n\n` +
    `## CRITICAL INSTRUCTIONS\n\n` +
    `*ENCODE THE CONTENT, NOT THE METADATA*\n` +
    `• ❌ DON'T encode: \"user sent message, assistant replied\"\n` +
    `• ✅ DO encode: Topics discussed, decisions made, insights generated, architecture defined, strategy validated\n\n` +
    `*YOUR TASK:*\n` +
    `Extract and compress the SEMANTIC CONTENT of our conversation into the RL4 blocks below.\n\n` +
    `---\n\n`
  );
}

function buildBlocksSpec() {
  // Keep compact but deterministic for the extension.
  return (
    `## RL4 FORMAT STRUCTURE\n\n` +
    `1) <RL4-ARCH>phase|key:value|key:value|compress:XX%</RL4-ARCH>\n` +
    `2) <RL4-LAYERS> ... </RL4-LAYERS>\n` +
    `3) <RL4-TOPICS> ... </RL4-TOPICS>\n` +
    `4) <RL4-TIMELINE> ... VELOCITY:..|CLARITY:..|DECISIONS:.. </RL4-TIMELINE>\n` +
    `5) <RL4-DECISIONS> ... include rejected:... </RL4-DECISIONS>\n` +
    `6) <RL4-INSIGHTS>patterns=... correlations=... risks=... recommendations=... </RL4-INSIGHTS>\n` +
    `7) ## 📋 HUMAN SUMMARY (8–12 lines max)\n` +
    `Then: <RL4-END/>\n\n` +
    `SPECIAL REQUIREMENTS (Ping‑Pong)\n` +
    `- In DECISIONS, separate: validated_intents, rejected, constraints/control_style.\n` +
    `- Include drift guards: “Do NOT re-propose rejected directions”.\n\n`
  );
}

function buildChunkNotesSpec() {
  return (
    `OUTPUT (CHUNK NOTES ONLY)\n` +
    `- Provide a compact notes block for THIS CHUNK ONLY.\n` +
    `- No RL4 blocks yet. No human summary. No extra sections.\n\n` +
    `<RL4-CHUNK>\n` +
    `topics:\n- ...\n` +
    `decisions:\n- ...\n` +
    `rejected:\n- ...\n` +
    `constraints/control_style:\n- ...\n` +
    `open_questions:\n- ...\n` +
    `</RL4-CHUNK>\n`
  );
}

const chunkPlanCache = new Map(); // convKey -> Array<{start:number,end:number,chars:number}>

async function computeChunkPlan(convKey, maxChars = 45000) {
  const key = String(convKey || '');
  if (!key) return [];
  const cacheKey = `${key}|${maxChars}`;
  if (chunkPlanCache.has(cacheKey)) return chunkPlanCache.get(cacheKey);
  const db = await openTranscriptDb();
  const msgs = await idbGetAllByIndex(db, 'messages', 'byConvKey', key);
  msgs.sort((a, b) => (a.idx || 0) - (b.idx || 0));
  const plan = [];
  let i = 0;
  while (i < msgs.length) {
    let chars = 0;
    const start = i;
    while (i < msgs.length) {
      const m = msgs[i];
      const c = (m && m.content ? String(m.content) : '').trim();
      const add = c ? c.length + 24 : 0; // rough role+sep overhead
      if (chars > 0 && chars + add > maxChars) break;
      chars += add;
      i++;
    }
    const end = i; // exclusive
    if (end <= start) break;
    plan.push({ start, end, chars });
  }
  chunkPlanCache.set(cacheKey, plan);
  return plan;
}

function isSupportedUrl(url) {
  const u = String(url || '');
  return (
    u.startsWith('https://claude.ai/') ||
    u.startsWith('https://chatgpt.com/') ||
    u.startsWith('https://chat.openai.com/') ||
    u.startsWith('https://gemini.google.com/') ||
    u.startsWith('https://bard.google.com/') ||
    u.startsWith('https://g.co/') ||
    u.startsWith('https://www.perplexity.ai/') ||
    u.startsWith('https://perplexity.ai/') ||
    u.startsWith('https://copilot.microsoft.com/')
  );
}

async function refreshFocusedNormalWindow(windowId) {
  try {
    if (typeof windowId !== 'number') return;
    const win = await chrome.windows.get(windowId, { populate: false });
    if (!win || win.type !== 'normal') return;
    lastFocusedNormalWindowId = windowId;
  } catch (_) {
    // ignore
  }
}

async function getFocusedSupportedTab() {
  try {
    const windowId = typeof lastFocusedNormalWindowId === 'number' ? lastFocusedNormalWindowId : null;
    const tabId = windowId !== null ? (activeTabIdByWindow.get(windowId) || null) : null;
    if (tabId !== null) {
      const tab = await chrome.tabs.get(tabId);
      if (tab && typeof tab.id === 'number' && isSupportedUrl(tab.url)) return tab;
    }
    // Fallback: active tab in last focused normal window (if map missed an event)
    if (windowId !== null) {
      const [t] = await chrome.tabs.query({ windowId, active: true });
      if (t && typeof t.id === 'number' && isSupportedUrl(t.url)) return t;
    }
  } catch (_) {}
  return null;
}

async function rememberSupportedTab(sender, explicitUrl) {
  try {
    const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
    const windowId = sender && sender.tab && typeof sender.tab.windowId === 'number' ? sender.tab.windowId : null;
    const url = String(explicitUrl || (sender && sender.tab ? sender.tab.url : '') || '');
    if (tabId === null || !isSupportedUrl(url)) return;
    await chrome.storage.local.set({
      [STORAGE_KEYS.LAST_SUPPORTED_TAB]: { tabId, windowId, url, updatedAt: Date.now() }
    });
  } catch (_) {
    // ignore
  }
}

async function setupDeclarativeVisibility() {
  if (!chrome.declarativeContent || !chrome.declarativeContent.onPageChanged) return;
  try {
    await chrome.declarativeContent.onPageChanged.removeRules();
    // IMPORTANT: declarativeContent Rule conditions are conjunctive; use one rule per host.
    const hosts = [
      'claude.ai',
      'chatgpt.com',
      'chat.openai.com',
      'gemini.google.com',
      'bard.google.com',
      'g.co',
      'www.perplexity.ai',
      'perplexity.ai',
      'copilot.microsoft.com'
    ];
    await chrome.declarativeContent.onPageChanged.addRules(
      hosts.map((hostEquals) => ({
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostEquals, schemes: ['https'] }
          })
        ],
        actions: [new chrome.declarativeContent.ShowAction()]
      }))
    );
  } catch (_) {
    // ignore
  }
}

async function updateActionForTab(tabId, url) {
  if (typeof tabId !== 'number') return;
  const supported = isSupportedUrl(url);
  try {
    if (supported) chrome.action.enable(tabId);
    else chrome.action.disable(tabId);
  } catch (_) {
    // ignore
  }
}

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[RL4] Extension installed', details.reason);
  
  if (details.reason === 'install') {
    console.log('[RL4] First installation - ready to capture Claude conversations');
  } else if (details.reason === 'update') {
    console.log('[RL4] Extension updated');
  }

  // Show the RL4 icon only on supported providers.
  setupDeclarativeVisibility().catch(() => {});
});

// Toolbar click behavior:
// - On supported sites: open the in-page RL4 panel (bottom-right) via content script.
// - On non-supported sites: show a small disclaimer window.
chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab && typeof tab.id === 'number' ? tab.id : null;
  const tabUrl = tab && tab.url ? String(tab.url) : '';

  // Remember the target tab so the RL4 UI can target the right page (side panel is optional).
  await rememberSupportedTab({ tab }, tabUrl);

  // If user clicks the pinned icon on a non-supported site, show a small disclaimer.
  if (!isSupportedUrl(tabUrl)) {
    if (chrome.windows && typeof chrome.windows.create === 'function') {
      chrome.windows.create({
        url: chrome.runtime.getURL('disclaimer.html'),
        type: 'popup',
        width: 360,
        height: 160,
        focused: true
      });
    }
    return;
  }

  // Supported site: open the in-page widget (Crisp/Intercom-style) injected by content.js.
  try {
    if (tabId !== null) {
      chrome.tabs.sendMessage(tabId, { action: 'openRl4InpagePanel' }, () => {});
      return;
    }
  } catch (_) {}
});

// Optional: Handle messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.action === 'rl4_get_focused_supported_tab') {
    (async () => {
      try {
        const tab = await getFocusedSupportedTab();
        sendResponse({ ok: true, tab: tab || null });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (request && request.action === 'rl4_supported_tab_ping') {
    const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
    const url = request && request.url ? String(request.url) : (sender && sender.tab ? String(sender.tab.url || '') : '');
    updateActionForTab(tabId, url).catch(() => {});
    rememberSupportedTab(sender, url).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (request.action === 'log') {
    console.log('[RL4 Background]', request.message);
    sendResponse({ success: true });
  }

  // --- Transcript ingest from content scripts ---
  if (request && request.action === 'rl4_transcript_upsert') {
    (async () => {
      try {
        const convKey = String(request.convKey || '');
        const provider = String(request.provider || '');
        const convId = String(request.convId || '');
        const transcriptSha256 = String(request.transcript_sha256 || '');
        const completeness = String(request.completeness || 'unknown');
        const completenessReason = String(request.completeness_reason || '');
        const apiUrl = String(request.api_url || '');
        const pagesFetched = typeof request.pages_fetched === 'number' ? request.pages_fetched : null;
        const totalMessages = typeof request.total_messages === 'number' ? request.total_messages : null;
        const approxChars = typeof request.approx_chars === 'number' ? request.approx_chars : null;
        const chunk = Array.isArray(request.messages) ? request.messages : [];

        if (!convKey || !provider) {
          sendResponse({ ok: false, error: 'missing_convKey_or_provider' });
          return;
        }

        const db = await openTranscriptDb();
        const now = Date.now();
        // Upsert messages (idx is 0-based, stable per capture run)
        const toPut = [];
        for (const m of chunk) {
          const idx = typeof m?.idx === 'number' ? m.idx : null;
          if (idx === null) continue;
          const role = m?.role === 'user' || m?.role === 'assistant' ? m.role : null;
          const content = String(m?.content || '');
          if (!content) continue;
          toPut.push({
            convKey,
            idx,
            role,
            content,
            timestamp: typeof m?.timestamp === 'string' ? m.timestamp : '',
            len: content.length,
            updatedAt: now
          });
        }
        if (toPut.length) await idbPutMany(db, 'messages', toPut);

        // Conversation record (small)
        const prev = await idbGet(db, 'conversations', convKey);
        const rec = {
          convKey,
          provider,
          convId,
          transcript_sha256: transcriptSha256 || (prev && prev.transcript_sha256) || '',
          completeness,
          completeness_reason: completenessReason || (prev && prev.completeness_reason) || '',
          api_url: apiUrl || (prev && prev.api_url) || '',
          pages_fetched: pagesFetched !== null ? pagesFetched : (prev && prev.pages_fetched) || null,
          message_count: totalMessages !== null ? totalMessages : (prev && prev.message_count) || null,
          approx_chars: approxChars !== null ? approxChars : (prev && prev.approx_chars) || null,
          updatedAt: now,
          createdAt: (prev && prev.createdAt) || now
        };
        await idbPut(db, 'conversations', rec);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[RL4] rl4_transcript_upsert failed', e);
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (request && request.action === 'rl4_transcript_get_stats') {
    (async () => {
      try {
        const convKey = String(request.convKey || '');
        if (!convKey) {
          sendResponse({ ok: false, error: 'missing_convKey' });
          return;
        }
        const db = await openTranscriptDb();
        const rec = await idbGet(db, 'conversations', convKey);
        sendResponse({ ok: true, conversation: rec || null });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (request && request.action === 'rl4_transcript_get_chunk_plan') {
    (async () => {
      try {
        const convKey = String(request.convKey || '');
        const maxChars = typeof request.max_chars === 'number' ? request.max_chars : 45000;
        const plan = await computeChunkPlan(convKey, maxChars);
        sendResponse({ ok: true, plan });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (request && request.action === 'rl4_transcript_get_chunk_prompt') {
    (async () => {
      try {
        const convKey = String(request.convKey || '');
        const chunkIndex = typeof request.chunk_index === 'number' ? request.chunk_index : 0;
        const maxChars = typeof request.max_chars === 'number' ? request.max_chars : 45000;
        const plan = await computeChunkPlan(convKey, maxChars);
        if (!plan.length) {
          sendResponse({ ok: false, error: 'no_plan' });
          return;
        }
        if (chunkIndex < 0 || chunkIndex >= plan.length) {
          sendResponse({ ok: false, error: 'bad_chunk_index', chunkTotal: plan.length });
          return;
        }
        const db = await openTranscriptDb();
        const msgs = await idbGetAllByIndex(db, 'messages', 'byConvKey', convKey);
        msgs.sort((a, b) => (a.idx || 0) - (b.idx || 0));
        const range = plan[chunkIndex];
        const slice = msgs.slice(range.start, range.end).map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content
        }));
        const transcript = encodeMessagesCompact(slice);
        const prompt =
          buildUniversalEncoderHeader() +
          `CHUNK ${chunkIndex + 1}/${plan.length}\n` +
          `You will receive ONLY a slice of the full conversation.\n` +
          `Do NOT invent missing context outside this chunk.\n\n` +
          buildChunkNotesSpec() +
          `\n---\n\nTRANSCRIPT_CHUNK (ROLE:\\nCONTENT separated by <|RL4_MSG|>):\n\n` +
          transcript +
          `\n\n@rl4:version=4.0|type=encoder-chunk|status=ready\n`;
        sendResponse({ ok: true, chunkIndex, chunkTotal: plan.length, prompt });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (request && request.action === 'rl4_transcript_get_merge_prompt') {
    (async () => {
      try {
        const notes = Array.isArray(request.chunk_notes) ? request.chunk_notes : [];
        const prompt =
          buildUniversalEncoderHeader() +
          `You are given CHUNK NOTES from multiple chunks of the same conversation.\n` +
          `Merge them into ONE final RL4 output.\n\n` +
          buildBlocksSpec() +
          `NOW ENCODE OUR CONVERSATION\n\n` +
          `CHUNK_NOTES:\n\n` +
          notes.map((n, i) => `--- CHUNK ${i + 1} ---\n${String(n || '').trim()}`).join('\n\n') +
          `\n\n@rl4:version=4.0|type=encoder-merge|status=ready\n`;
        sendResponse({ ok: true, prompt });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (request && request.action === 'rl4_chunk_notes_save') {
    (async () => {
      try {
        const convKey = String(request.convKey || '');
        const notes = Array.isArray(request.notes) ? request.notes : [];
        if (!convKey) {
          sendResponse({ ok: false, error: 'missing_convKey' });
          return;
        }
        await chrome.storage.local.set({ [`${STORAGE_KEYS.CHUNK_NOTES_PREFIX}${convKey}`]: notes });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (request && request.action === 'rl4_chunk_notes_load') {
    (async () => {
      try {
        const convKey = String(request.convKey || '');
        if (!convKey) {
          sendResponse({ ok: false, error: 'missing_convKey' });
          return;
        }
        const key = `${STORAGE_KEYS.CHUNK_NOTES_PREFIX}${convKey}`;
        const res = await chrome.storage.local.get([key]);
        const notes = Array.isArray(res[key]) ? res[key] : [];
        sendResponse({ ok: true, notes });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }
  
  // Return true to indicate we will send a response asynchronously
  return true;
});

// Keep focused window + active tab tracking up to date
try {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    refreshFocusedNormalWindow(windowId).catch(() => {});
  });
  chrome.tabs.onActivated.addListener((activeInfo) => {
    try {
      if (!activeInfo || typeof activeInfo.windowId !== 'number' || typeof activeInfo.tabId !== 'number') return;
      activeTabIdByWindow.set(activeInfo.windowId, activeInfo.tabId);
      // Best-effort: treat activation as focus signal for normal windows too.
      refreshFocusedNormalWindow(activeInfo.windowId).catch(() => {});
    } catch (_) {}
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    try {
      if (changeInfo && changeInfo.status !== 'complete') return;
      if (!tab || typeof tab.windowId !== 'number') return;
      // If this tab is active in its window, update cache.
      if (tab.active) {
        activeTabIdByWindow.set(tab.windowId, tabId);
      }
    } catch (_) {}
  });
  // Init at startup
  chrome.windows.getLastFocused({ populate: true }, (win) => {
    try {
      if (!win || win.type !== 'normal') return;
      lastFocusedNormalWindowId = win.id;
      const active = Array.isArray(win.tabs) ? win.tabs.find((t) => t && t.active) : null;
      if (active && typeof active.id === 'number') activeTabIdByWindow.set(win.id, active.id);
    } catch (_) {}
  });
} catch (_) {
  // ignore
}

// Keep action enabled only on supported sites.
try {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo && typeof changeInfo.url === 'string' ? changeInfo.url : (tab && tab.url ? String(tab.url) : '');
    if (!url) return;
    updateActionForTab(tabId, url).catch(() => {});
  });
  chrome.tabs.onActivated.addListener(async (info) => {
    try {
      const tab = await chrome.tabs.get(info.tabId);
      updateActionForTab(info.tabId, tab && tab.url ? String(tab.url) : '').catch(() => {});
    } catch (_) {}
  });
} catch (_) {
  // ignore
}

