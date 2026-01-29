/**
 * RL4 Snapshot Extension - Popup Logic
 * Orchestrates snapshot generation, clipboard copy, and UI updates
 */

let currentSnapshot = null;
let hasSnapshotInThisUiSession = false;
let cachedLastPrompt = '';
let optionsExpanded = false;
let flowSticky = false; // keep Step 2/3 UI visible until Reload
let chunkExpanded = false;
let chunkPlan = [];
let chunkNotes = [];
let chunkConvKey = '';
let chunkMaxChars = 45000;
let metaExpanded = false;

const STORAGE_KEYS = {
  LAST_PROMPT: 'rl4_last_prompt_v1',
  CAPTURE_PROGRESS: 'rl4_capture_progress_v1',
  LAST_SNAPSHOT: 'rl4_last_snapshot_v1',
  LAST_SNAPSHOT_BY_TAB: 'rl4_last_snapshot_by_tab_v1',
  RL4_BLOCKS: 'rl4_blocks_v1',
  RL4_BLOCKS_STATUS: 'rl4_blocks_status_v1',
  LAST_SUPPORTED_TAB: 'rl4_last_supported_tab_v1',
  UI_FLOW: 'rl4_ui_flow_v1'
};

function setChunkExpanded(isExpanded) {
  const body = document.getElementById('chunkBody');
  const btn = document.getElementById('chunkToggleBtn');
  const expanded = !!isExpanded;
  chunkExpanded = expanded;
  if (body) {
    if (expanded) body.classList.remove('hidden');
    else body.classList.add('hidden');
  }
  if (btn) {
    btn.textContent = expanded ? 'Hide' : 'Show';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

function getConvKeyFromSnapshot(snap) {
  try {
    const ref = snap && snap.metadata && typeof snap.metadata.transcript_ref === 'string' ? snap.metadata.transcript_ref : '';
    return String(ref || '').trim();
  } catch (_) {
    return '';
  }
}

async function bgSend(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => resolve(resp || null));
    } catch (_) {
      resolve(null);
    }
  });
}

function updateChunkPlanInfo() {
  const info = document.getElementById('chunkPlanInfo');
  const idxInput = document.getElementById('chunkIndexInput');
  const total = Array.isArray(chunkPlan) ? chunkPlan.length : 0;
  const saved = Array.isArray(chunkNotes) ? chunkNotes.filter((x) => String(x || '').trim().length > 0).length : 0;
  if (info) info.textContent = total ? `Chunks: ${total} | Saved notes: ${saved}/${total}` : '-';
  if (idxInput) {
    idxInput.max = total ? String(total) : '1';
    if (!idxInput.value) idxInput.value = '1';
    const v = Math.max(1, Math.min(total || 1, parseInt(idxInput.value, 10) || 1));
    idxInput.value = String(v);
  }
}

function loadChunkNotesIntoTextarea() {
  const idxInput = document.getElementById('chunkIndexInput');
  const ta = document.getElementById('chunkNotesInput');
  const total = Array.isArray(chunkPlan) ? chunkPlan.length : 0;
  const idx1 = idxInput ? parseInt(idxInput.value, 10) || 1 : 1;
  const ix = Math.max(1, Math.min(total || 1, idx1)) - 1;
  const existing = Array.isArray(chunkNotes) && typeof chunkNotes[ix] === 'string' ? chunkNotes[ix] : '';
  if (ta) ta.value = existing || '';
}

async function initChunkEncoderFromSnapshot(snap) {
  const wrap = document.getElementById('chunkEncoder');
  const storeInfo = document.getElementById('transcriptStoreInfo');
  const convKey = getConvKeyFromSnapshot(snap);
  chunkConvKey = convKey;

  if (!wrap) return;
  if (!convKey) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');

  // Load conversation stats from background IndexedDB.
  const stats = await bgSend({ action: 'rl4_transcript_get_stats', convKey });
  const conv = stats && stats.ok && stats.conversation ? stats.conversation : null;
  const completeness = String(snap?.metadata?.capture_completeness || conv?.completeness || 'unknown');
  const reason = String(snap?.metadata?.capture_completeness_reason || conv?.completeness_reason || '');
  const pages = snap?.metadata?.capture_pages_fetched ?? conv?.pages_fetched ?? null;
  const sha = String(snap?.metadata?.transcript_sha256 || conv?.transcript_sha256 || snap?.conversation_fingerprint?.sha256 || '');
  const msgCount = snap?.metadata?.total_messages ?? snap?.metadata?.messages ?? conv?.message_count ?? null;

  if (storeInfo) {
    storeInfo.classList.remove('hidden');
    storeInfo.textContent =
      `Store: IndexedDB (background)\n` +
      `transcript_ref: ${convKey}\n` +
      (sha ? `transcript_sha256: ${sha}\n` : '') +
      (msgCount !== null ? `messages: ${msgCount}\n` : '') +
      `capture_completeness: ${completeness}` +
      (reason ? ` (${reason})` : '') +
      (pages !== null ? `\npages_fetched: ${pages}` : '');
  }

  // Load chunk plan + saved notes.
  const planRes = await bgSend({ action: 'rl4_transcript_get_chunk_plan', convKey, max_chars: chunkMaxChars });
  chunkPlan = planRes && planRes.ok && Array.isArray(planRes.plan) ? planRes.plan : [];
  const notesRes = await bgSend({ action: 'rl4_chunk_notes_load', convKey });
  chunkNotes = notesRes && notesRes.ok && Array.isArray(notesRes.notes) ? notesRes.notes : [];
  if (chunkNotes.length < chunkPlan.length) {
    chunkNotes = [...chunkNotes, ...new Array(chunkPlan.length - chunkNotes.length).fill('')];
  }
  updateChunkPlanInfo();
  loadChunkNotesIntoTextarea();

  // Keep collapsed by default (so it doesn't overwhelm the normal flow).
  setChunkExpanded(false);
}

async function getRememberedSupportedTab() {
  try {
    const res = await chrome.storage.local.get([STORAGE_KEYS.LAST_SUPPORTED_TAB]);
    const v = res && res[STORAGE_KEYS.LAST_SUPPORTED_TAB] && typeof res[STORAGE_KEYS.LAST_SUPPORTED_TAB] === 'object'
      ? res[STORAGE_KEYS.LAST_SUPPORTED_TAB]
      : null;
    if (!v || typeof v.tabId !== 'number') return null;
    const now = Date.now();
    const fresh = typeof v.updatedAt === 'number' ? now - v.updatedAt < 30 * 60_000 : true;
    if (!fresh) return null;
    try {
      const tab = await chrome.tabs.get(v.tabId);
      return tab && typeof tab.id === 'number' ? tab : null;
    } catch (_) {
      return null;
    }
  } catch (_) {
    return null;
  }
}

async function getTargetActiveTab() {
  const isSupportedUrl = (url) => {
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
  };

  const rememberTab = async (tab) => {
    try {
      if (!tab || typeof tab.id !== 'number') return;
      const url = String(tab.url || '');
      if (!isSupportedUrl(url)) return;
      await chrome.storage.local.set({
        [STORAGE_KEYS.LAST_SUPPORTED_TAB]: { tabId: tab.id, windowId: tab.windowId, url, updatedAt: Date.now() }
      });
    } catch (_) {
      // ignore
    }
  };

  // 0) Ask the background service worker for the focused supported tab (most reliable in extension popups).
  try {
    const resp = await bgSend({ action: 'rl4_get_focused_supported_tab' });
    const tab = resp && resp.ok && resp.tab && typeof resp.tab.id === 'number' ? resp.tab : null;
    if (tab && isSupportedUrl(tab.url)) {
      await rememberTab(tab);
      return tab;
    }
  } catch (_) {}

  // 1) Prefer the CURRENT active supported tab from the last focused *normal* window.
  // Note: in Chrome extension popups, `lastFocusedWindow/currentWindow` can refer to the popup itself,
  // which has no tabs. Use windows API to find the last focused normal browser window.
  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    if (win && win.type === 'normal' && Array.isArray(win.tabs)) {
      const active = win.tabs.find((t) => t && t.active);
      if (active && typeof active.id === 'number' && isSupportedUrl(active.url)) {
        await rememberTab(active);
        return active;
      }
    }
  } catch (_) {}

  // 2) Next best: any active supported tab across normal windows.
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    const normalWins = Array.isArray(wins) ? wins.filter((w) => w && w.type === 'normal') : [];
    for (const w of normalWins) {
      const active = Array.isArray(w.tabs) ? w.tabs.find((t) => t && t.active) : null;
      if (active && typeof active.id === 'number' && isSupportedUrl(active.url)) {
        await rememberTab(active);
        return active;
      }
    }
  } catch (_) {}

  // 3) Fallback: the last provider tab remembered by background scripts.
  const remembered = await getRememberedSupportedTab();
  if (remembered) return remembered;

  // 4) Final fallback: any active tab from the last focused normal window.
  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    if (win && win.type === 'normal' && Array.isArray(win.tabs)) {
      const active = win.tabs.find((t) => t && t.active);
      if (active && typeof active.id === 'number') return active;
    }
  } catch (_) {}
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    const normalWins = Array.isArray(wins) ? wins.filter((w) => w && w.type === 'normal') : [];
    for (const w of normalWins) {
      const active = Array.isArray(w.tabs) ? w.tabs.find((t) => t && t.active) : null;
      if (active && typeof active.id === 'number') return active;
    }
  } catch (_) {}
  return null;
}

async function saveLastPrompt(prompt) {
  const p = String(prompt || '');
  if (!p) return;
  // Avoid quota issues if someone enables full transcript and it becomes enormous.
  if (p.length > 1_500_000) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_PROMPT]: p });
}

async function loadLastPrompt() {
  const res = await chrome.storage.local.get([STORAGE_KEYS.LAST_PROMPT]);
  return res && typeof res[STORAGE_KEYS.LAST_PROMPT] === 'string' ? res[STORAGE_KEYS.LAST_PROMPT] : '';
}

async function loadLastSnapshot() {
  const res = await chrome.storage.local.get([STORAGE_KEYS.LAST_SNAPSHOT]);
  const s = res && res[STORAGE_KEYS.LAST_SNAPSHOT] && typeof res[STORAGE_KEYS.LAST_SNAPSHOT] === 'object'
    ? res[STORAGE_KEYS.LAST_SNAPSHOT]
    : null;
  return s;
}

async function loadLastSnapshotForTab(tabId) {
  try {
    if (typeof tabId !== 'number') return null;
    const res = await chrome.storage.local.get([STORAGE_KEYS.LAST_SNAPSHOT_BY_TAB]);
    const map = res && res[STORAGE_KEYS.LAST_SNAPSHOT_BY_TAB] && typeof res[STORAGE_KEYS.LAST_SNAPSHOT_BY_TAB] === 'object'
      ? res[STORAGE_KEYS.LAST_SNAPSHOT_BY_TAB]
      : null;
    if (!map) return null;
    const s = map[String(tabId)];
    return s && typeof s === 'object' ? s : null;
  } catch (_) {
    return null;
  }
}

async function loadSnapshotForTabOrGlobal(tabId) {
  const byTab = await loadLastSnapshotForTab(tabId);
  if (byTab) return byTab;
  return await loadLastSnapshot();
}

async function loadRl4BlocksStatus() {
  const res = await chrome.storage.local.get([STORAGE_KEYS.RL4_BLOCKS_STATUS]);
  const s = res && res[STORAGE_KEYS.RL4_BLOCKS_STATUS] && typeof res[STORAGE_KEYS.RL4_BLOCKS_STATUS] === 'object'
    ? res[STORAGE_KEYS.RL4_BLOCKS_STATUS]
    : null;
  return s;
}

async function loadUiFlow() {
  try {
    const res = await chrome.storage.local.get([STORAGE_KEYS.UI_FLOW]);
    const v = res && res[STORAGE_KEYS.UI_FLOW] && typeof res[STORAGE_KEYS.UI_FLOW] === 'object' ? res[STORAGE_KEYS.UI_FLOW] : null;
    return v;
  } catch (_) {
    return null;
  }
}

async function saveUiFlow(v) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.UI_FLOW]: v });
  } catch (_) {}
}

function renderRl4BlocksStatus(statusObj) {
  const manualWrap = document.getElementById('rl4BlocksManual');
  const copyFinalBtn = document.getElementById('copyPromptBtn');
  const ta = document.getElementById('rl4BlocksInput');
  const s = statusObj && typeof statusObj === 'object' ? statusObj : null;
  if (!s || !s.status) {
    if (flowSticky) manualWrap?.classList.remove('hidden');
    else manualWrap?.classList.add('hidden');
    if (copyFinalBtn) copyFinalBtn.disabled = true;
    return;
  }

  const status = String(s.status || '');
  if (status === 'awaiting') {
    manualWrap?.classList.remove('hidden');
    if (copyFinalBtn) copyFinalBtn.disabled = true;
    return;
  }
  if (status === 'captured') {
    if (!flowSticky) manualWrap?.classList.add('hidden');
    if (copyFinalBtn) copyFinalBtn.disabled = true;
    return;
  }
  if (status === 'sealed') {
    // Post-finalize: keep ONE CTA on screen (Copy Final Prompt).
    manualWrap?.classList.add('hidden');
    if (copyFinalBtn) copyFinalBtn.disabled = false;
    // UX: when blocks were auto-captured by the content script, Step 3 paste box can disappear.
    // Make it explicit that nothing needs to be pasted.
    try {
      chrome.storage.local.get([STORAGE_KEYS.RL4_BLOCKS], (res) => {
        const b = res && res[STORAGE_KEYS.RL4_BLOCKS] && typeof res[STORAGE_KEYS.RL4_BLOCKS] === 'object'
          ? res[STORAGE_KEYS.RL4_BLOCKS]
          : null;
        const reason = b && typeof b.reason === 'string' ? b.reason : '';
        if (reason && reason !== 'manual') {
          showStatus('success', '✓ LLM response auto-captured.\n\nNo paste needed. You can directly copy the final prompt (Step 4).');
          // Populate the textarea with the captured blocks (read-only) to avoid confusion.
          try {
            const blocks = b && b.blocks && typeof b.blocks === 'object' ? b.blocks : null;
            if (ta && blocks) {
              const parts = [];
              if (typeof blocks.arch === 'string') parts.push(blocks.arch.trim());
              if (typeof blocks.layers === 'string') parts.push(blocks.layers.trim());
              if (typeof blocks.topics === 'string') parts.push(blocks.topics.trim());
              if (typeof blocks.timeline === 'string') parts.push(blocks.timeline.trim());
              if (typeof blocks.decisions === 'string') parts.push(blocks.decisions.trim());
              if (typeof blocks.insights === 'string') parts.push(blocks.insights.trim());
              if (typeof blocks.human_summary === 'string' && blocks.human_summary.trim()) parts.push(blocks.human_summary.trim());
              parts.push('<RL4-END/>');
              ta.value = parts.filter(Boolean).join('\n\n');
              ta.disabled = true;
            }
          } catch (_) {}
        }
      });
    } catch (_) {}
    return;
  }
  if (status === 'error') {
    manualWrap?.classList.remove('hidden');
    if (copyFinalBtn) copyFinalBtn.disabled = true;
    return;
  }
  manualWrap?.classList.remove('hidden');
  if (copyFinalBtn) copyFinalBtn.disabled = true;
}

let rl4BlocksPollTimer = null;
function stopRl4BlocksPoll() {
  if (rl4BlocksPollTimer) clearInterval(rl4BlocksPollTimer);
  rl4BlocksPollTimer = null;
}

function startRl4BlocksPoll({ onSealed } = {}) {
  stopRl4BlocksPoll();
  rl4BlocksPollTimer = setInterval(async () => {
    try {
      const s = await loadRl4BlocksStatus();
      renderRl4BlocksStatus(s);
      refreshGuidance().catch(() => {});
      if (s && s.status === 'sealed') {
        stopRl4BlocksPoll();
        onSealed?.(s);
      }
    } catch (_) {
      // ignore
    }
  }, 500);
}

function renderLastPrompt(prompt) {
  const wrap = document.getElementById('lastPrompt');
  const textEl = document.getElementById('lastPromptText');
  if (!wrap || !textEl) return;
  const p = String(prompt || '').trim();
  if (!p) {
    wrap.classList.add('hidden');
    textEl.textContent = '';
    return;
  }
  textEl.textContent = p;
  // Always show when we have a saved prompt (this is the persistent “last final prompt” access).
  wrap.classList.remove('hidden');
}

function flashOnce(el, className = 'rl4-clicked', ms = 900) {
  if (!el || !el.classList) return;
  try {
    el.classList.remove(className);
    // force reflow so animation can replay
    // eslint-disable-next-line no-unused-expressions
    el.offsetWidth;
    el.classList.add(className);
    setTimeout(() => el.classList.remove(className), ms);
  } catch (_) {}
}

function buildLocalRl4BlocksText(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const md = s.metadata && typeof s.metadata === 'object' ? s.metadata : {};
  const protocol = typeof s.protocol === 'string' ? s.protocol : 'RCEP_v1';
  const compress = String(md.compression_digest || md.compression_ratio || md.compression_bundle || 'NOT_AVAILABLE');

  const topicsArr = Array.isArray(s.topics) ? s.topics : [];
  const topTopics = topicsArr
    .slice()
    .sort((a, b) => (b?.weight || 0) - (a?.weight || 0))
    .slice(0, 8)
    .map((t) => {
      const label = String(t?.label || '').trim() || 'NOT_AVAILABLE';
      const w = typeof t?.weight === 'number' ? t.weight : null;
      return w !== null ? `${label}(${w})` : label;
    })
    .join(', ');

  const timeline =
    Array.isArray(s.timeline_macro) && s.timeline_macro.length
      ? s.timeline_macro
          .slice(0, 6)
          .map((p) => `${String(p?.phase || 'Phase')}: ${String(p?.summary || '').trim() || 'NOT_AVAILABLE'}`)
          .join(' | ')
      : Array.isArray(s.timeline_summary) && s.timeline_summary.length
        ? s.timeline_summary
            .slice(0, 3)
            .map((t) => String(t?.summary || '').trim())
            .filter(Boolean)
            .join(' | ')
        : '';

  const contextSummary =
    String(s.context_summary_ultra || s.context_summary || s.context_state?.current_goal || '').trim() || 'NOT_AVAILABLE';

  // Derive lightweight, safe fields (no invention).
  const validatedIntents =
    Array.isArray(s.semantic_spine?.open_questions) && s.semantic_spine.open_questions.length
      ? s.semantic_spine.open_questions.slice(0, 3).join(' | ')
      : contextSummary;

  const rejected =
    Array.isArray(s.semantic_spine?.rejected_alternatives) ? s.semantic_spine.rejected_alternatives : [];

  const constraints =
    'NOT_AVAILABLE';

  const controlStyle =
    'NOT_AVAILABLE';

  // Ensure at least one substantial block body (content.js requires >40 chars in timeline/decisions/insights or >20 in arch).
  const timelineBody =
    (timeline && timeline.trim().length > 0 ? timeline.trim() : `Summary: ${contextSummary}`) +
    ` | VELOCITY:NOT_AVAILABLE|CLARITY:NOT_AVAILABLE|DECISIONS:NOT_AVAILABLE`;

  const archBody = `phase:NOT_AVAILABLE|compress:${compress}|protocol:${protocol}`;

  const topicsBody = topTopics ? topTopics : 'NOT_AVAILABLE';

  const decisionsBody =
    `validated_intents=${validatedIntents || 'NOT_AVAILABLE'}|` +
    `rejected=${JSON.stringify(rejected)}|` +
    `constraints=${constraints}|` +
    `control_style=${controlStyle}`;

  const insightsBody =
    `patterns=${topicsBody !== 'NOT_AVAILABLE' ? `topics:${topicsBody}` : 'NOT_AVAILABLE'} ` +
    `correlations=NOT_AVAILABLE risks=NOT_AVAILABLE recommendations=NOT_AVAILABLE`;

  const humanSummary = contextSummary;

  return (
    `<RL4-ARCH>${archBody}</RL4-ARCH>\n` +
    `<RL4-LAYERS>NOT_AVAILABLE</RL4-LAYERS>\n` +
    `<RL4-TOPICS>${topicsBody}</RL4-TOPICS>\n` +
    `<RL4-TIMELINE>${timelineBody}</RL4-TIMELINE>\n` +
    `<RL4-DECISIONS>${decisionsBody}</RL4-DECISIONS>\n` +
    `<RL4-INSIGHTS>${insightsBody}</RL4-INSIGHTS>\n` +
    `HUMAN SUMMARY:\n` +
    `${humanSummary}\n` +
    `<RL4-END/>`
  );
}

function setLastPromptExpanded(isExpanded) {
  const wrap = document.getElementById('lastPrompt');
  const textEl = document.getElementById('lastPromptText');
  const btn = document.getElementById('toggleLastPromptBtn');
  if (!wrap || !textEl) return;
  const expanded = !!isExpanded;
  wrap.dataset.expanded = expanded ? 'true' : 'false';
  textEl.style.display = expanded ? 'block' : 'none';
  wrap.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (btn) {
    btn.textContent = expanded ? 'Hide' : 'Show';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

function setOptionsExpanded(isExpanded) {
  const body = document.getElementById('optionsBody');
  const btn = document.getElementById('optionsToggleBtn');
  const expanded = !!isExpanded;
  optionsExpanded = expanded;
  if (body) {
    if (expanded) body.classList.remove('hidden');
    else body.classList.add('hidden');
  }
  if (btn) {
    btn.textContent = expanded ? 'Hide' : 'Show';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

function setMetaExpanded(isExpanded) {
  const details = document.getElementById('metaDetails');
  const btn = document.getElementById('metaToggleBtn');
  const expanded = !!isExpanded;
  metaExpanded = expanded;
  if (details) {
    if (expanded) details.classList.remove('hidden');
    else details.classList.add('hidden');
  }
  if (btn) {
    btn.textContent = expanded ? 'Hide' : 'Details';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

function setPostActionsEnabled(enabled) {
  // NOTE: UI is now a stage-based wizard; there is no single "postActions" container anymore.
  const viewRawBtn = document.getElementById('viewRawBtn');
  const copyEncoderPromptBtn = document.getElementById('copyEncoderPromptBtn');
  const copyLastPromptBtn = document.getElementById('copyLastPromptBtn');
  const rl4BlocksInput = document.getElementById('rl4BlocksInput');
  const finalizeBlocksBtn = document.getElementById('finalizeBlocksBtn');
  const chunkToggleBtn = document.getElementById('chunkToggleBtn');
  const copyChunkPromptBtn = document.getElementById('copyChunkPromptBtn');
  const saveChunkNotesBtn = document.getElementById('saveChunkNotesBtn');
  const copyMergePromptBtn = document.getElementById('copyMergePromptBtn');
  const chunkIndexInput = document.getElementById('chunkIndexInput');
  const chunkNotesInput = document.getElementById('chunkNotesInput');
  const on = !!enabled;

  if (copyEncoderPromptBtn) copyEncoderPromptBtn.disabled = !on;
  if (copyLastPromptBtn) copyLastPromptBtn.disabled = !on;
  if (chunkToggleBtn) chunkToggleBtn.disabled = !on;
  if (copyChunkPromptBtn) copyChunkPromptBtn.disabled = !on;
  if (saveChunkNotesBtn) saveChunkNotesBtn.disabled = !on;
  if (copyMergePromptBtn) copyMergePromptBtn.disabled = !on;
  if (chunkIndexInput) chunkIndexInput.disabled = !on;
  if (chunkNotesInput) chunkNotesInput.disabled = !on;

  // View raw JSON is a link; disable it via aria + pointer events.
  if (viewRawBtn) {
    if (on) {
      viewRawBtn.removeAttribute('aria-disabled');
      viewRawBtn.style.pointerEvents = '';
      viewRawBtn.style.opacity = '';
    } else {
      viewRawBtn.setAttribute('aria-disabled', 'true');
      viewRawBtn.style.pointerEvents = 'none';
      viewRawBtn.style.opacity = '0.55';
    }
  }

  // Keep finalization gated by actual RL4 blocks state, but prevent interaction before snapshot exists.
  if (!on) {
    if (rl4BlocksInput) rl4BlocksInput.disabled = true;
    if (finalizeBlocksBtn) finalizeBlocksBtn.disabled = true;
  } else {
    if (rl4BlocksInput) rl4BlocksInput.disabled = false;
    // finalizeBlocksBtn is enabled only when text is present (handled in click path) — keep it enabled.
    if (finalizeBlocksBtn) finalizeBlocksBtn.disabled = false;
  }
}

function clearGuidanceGlow() {
  const ids = [
    'generateBtn',
    'copyEncoderPromptBtn',
    'rl4BlocksManual',
    'rl4BlocksInput',
    'finalizeBlocksBtn',
    'copyPromptBtn',
    'metadata',
    'stage'
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.remove('rl4-guide-cta');
    el.classList.remove('rl4-guide-container');
    el.classList.remove('rl4-guide-input');
  }
}

function setStepper(step) {
  const label = document.getElementById('stepLabel');
  const hint = document.getElementById('stepHint');
  const fill = document.getElementById('stepperFill');
  const s = String(step || '');
  const map = {
    generate: { n: 1, hint: 'Generate a snapshot', pct: 25 },
    encode: { n: 2, hint: 'Copy the finalization prompt', pct: 50 },
    paste_response: { n: 3, hint: 'Paste LLM response', pct: 75 },
    finalize: { n: 3, hint: 'Finalize snapshot', pct: 75 },
    copy_final: { n: 4, hint: 'Copy final prompt', pct: 100 }
  };
  const m = map[s] || map.generate;
  if (label) label.textContent = `Step ${m.n}/4`;
  if (hint) hint.textContent = m.hint;
  if (fill) fill.style.width = `${m.pct}%`;
}

function renderStage(step) {
  const s = String(step || '');
  const s1 = document.getElementById('stageStep1');
  const s2 = document.getElementById('stageStep2');
  const s3 = document.getElementById('stageStep3');
  const s4 = document.getElementById('stageStep4');
  const captureProof = document.getElementById('captureProof');
  const metadata = document.getElementById('metadata');

  // Hide all step panels first.
  s1?.classList.add('hidden');
  s2?.classList.add('hidden');
  s3?.classList.add('hidden');
  s4?.classList.add('hidden');

  // Capture proof appears only for the *current* wizard run (not after Reload),
  // so Step 1 stays clean and stable.
  const hasSnap = !!currentSnapshot && hasSnapshotInThisUiSession === true;
  if (captureProof) {
    if (hasSnap) captureProof.classList.remove('hidden');
    else captureProof.classList.add('hidden');
  }
  if (metadata) {
    if (hasSnap) metadata.classList.remove('hidden');
    else metadata.classList.add('hidden');
  }

  if (s === 'generate') {
    s1?.classList.remove('hidden');
    return;
  }
  if (s === 'encode') {
    s2?.classList.remove('hidden');
    return;
  }
  if (s === 'paste_response' || s === 'finalize') {
    s3?.classList.remove('hidden');
    return;
  }
  if (s === 'copy_final') {
    s4?.classList.remove('hidden');
    // Post-finalize: keep ONE CTA on screen (Copy Final Prompt).
    // Step 3 (paste/finalize) is intentionally hidden to avoid confusion.
  }
}

function updateFinalizeButtonState() {
  const ta = document.getElementById('rl4BlocksInput');
  const btn = document.getElementById('finalizeBlocksBtn');
  if (!btn) return;
  const hasText = ta ? String(ta.value || '').trim().length > 0 : false;
  btn.disabled = !hasText;
}

function setGuidanceStep(step) {
  setStepper(step);
  // Use a single "stage" container that swaps content per step (prevents the UI from jumping).
  renderStage(step);
  clearGuidanceGlow();
  const s = String(step || '');
  const glowCta = (id) => document.getElementById(id)?.classList.add('rl4-guide-cta');
  const glowBox = (id) => document.getElementById(id)?.classList.add('rl4-guide-container');
  const glowInput = (id) => document.getElementById(id)?.classList.add('rl4-guide-input');

  if (s === 'generate') {
    glowCta('generateBtn');
    return;
  }
  if (s === 'encode') {
    glowCta('copyEncoderPromptBtn');
    return;
  }
  if (s === 'paste_response') {
    glowInput('rl4BlocksInput');
    return;
  }
  if (s === 'finalize') {
    glowCta('finalizeBlocksBtn');
    return;
  }
  if (s === 'copy_final') {
    glowCta('copyPromptBtn');
    return;
  }
}

function refreshLastPromptControls() {
  const wrap = document.getElementById('lastPrompt');
  const textEl = document.getElementById('lastPromptText');
  const copyBtn = document.getElementById('copyLastPromptBtn');
  if (!wrap || !textEl || !copyBtn) return;
  const hasText = String(textEl.textContent || '').trim().length > 0;
  copyBtn.disabled = !hasText;
}

async function computeGuidanceStep() {
  // Default: push user to Generate Context.
  if (!hasSnapshotInThisUiSession || !currentSnapshot) return 'generate';

  // If blocks are already sealed -> copy final snapshot.
  try {
    const s = await loadRl4BlocksStatus();
    const st = s && s.status ? String(s.status) : '';
    if (st === 'sealed') return 'copy_final';
    if (st === 'awaiting' || st === 'error') {
      const ta = document.getElementById('rl4BlocksInput');
      const hasText = ta ? String(ta.value || '').trim().length > 0 : false;
      return hasText ? 'finalize' : 'paste_response';
    }
    if (st === 'captured') return 'finalize';
  } catch (_) {}

  // Snapshot exists but not finalized -> encode next.
  return 'encode';
}

async function refreshGuidance() {
  try {
    const step = await computeGuidanceStep();
    setGuidanceStep(step);
  } catch (_) {
    // ignore
  }
}

async function resetUiForNewRun() {
  try {
    stopProgressPoll();
    stopRl4BlocksPoll();
  } catch (_) {}

  // Reset sticky sequence state.
  flowSticky = false;
  try {
    // Reset flow state so Reload starts from Step 1, but KEEP the last snapshot
    // so the user can still copy the last final prompt from the sticky bar.
    await chrome.storage.local.remove([
      STORAGE_KEYS.CAPTURE_PROGRESS,
      STORAGE_KEYS.RL4_BLOCKS,
      STORAGE_KEYS.RL4_BLOCKS_STATUS,
      STORAGE_KEYS.UI_FLOW,
      STORAGE_KEYS.LAST_SUPPORTED_TAB,
      // Also clear heavy per-chat state so a new XXL run starts with maximum storage headroom.
      'rl4_current_messages',
      'rl4_sessions_index',
      'rl4_current_session_id',
      'rl4_current_conv_id',
      'rl4_current_updated_at',
      'rl4_api_messages',
      'rl4_api_events'
    ]);
  } catch (_) {}
  saveUiFlow({ active: false, step: 'reset', updatedAt: Date.now() }).catch(() => {});

  hasSnapshotInThisUiSession = false;
  // Keep last snapshot in memory (sticky bar), but wizard goes back to Step 1.
  try {
    currentSnapshot = await loadLastSnapshot();
  } catch (_) {
  currentSnapshot = null;
  }

  // UI reset
  try {
    const meta = document.getElementById('metadata');
    // Keep metadata visible if we still have a last snapshot (proof-of-capture).
    if (!currentSnapshot) {
    meta?.classList.add('hidden');
    if (meta) meta.style.display = 'none';
    } else {
      updateMetadata(currentSnapshot);
    }
    // Only wipe metadata fields if we truly have no snapshot.
    if (!currentSnapshot) {
    const mc = document.getElementById('messageCount');
    const cr = document.getElementById('compressionRatio');
    const cs = document.getElementById('checksum');
    if (mc) mc.textContent = '-';
    if (cr) cr.textContent = '-';
    if (cs) cs.textContent = '-';
    }

    document.getElementById('rl4BlocksManual')?.classList.add('hidden');
    const ta = document.getElementById('rl4BlocksInput');
    if (ta) ta.value = '';
  } catch (_) {}

  setPostActionsEnabled(false);
  setLastPromptExpanded(false);
  renderLastPrompt(cachedLastPrompt);
  setBusy(false);
  // Don't show a static "Step 1" banner — the stepper already communicates the current step.
  // Keep status reserved for progress / warnings / errors / confirmations.
  const statusDiv = document.getElementById('status');
  if (statusDiv) {
    statusDiv.className = 'status hidden';
    statusDiv.textContent = '';
    statusDiv.classList.add('hidden');
  }
  refreshLastPromptControls();
  refreshGuidance().catch(() => {});
}

function setBusy(isBusy) {
  const el = document.getElementById('busySpinner');
  if (!el) return;
  if (isBusy) el.classList.remove('hidden');
  else el.classList.add('hidden');
}

let pollTimer = null;
function stopProgressPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startProgressPoll(captureId, { onDone, onError } = {}) {
  stopProgressPoll();
  pollTimer = setInterval(async () => {
    try {
      const res = await chrome.storage.local.get([STORAGE_KEYS.CAPTURE_PROGRESS]);
      const p = res && res[STORAGE_KEYS.CAPTURE_PROGRESS] && typeof res[STORAGE_KEYS.CAPTURE_PROGRESS] === 'object'
        ? res[STORAGE_KEYS.CAPTURE_PROGRESS]
        : null;

      if (!p) return;
      if (captureId && p.captureId && p.captureId !== captureId) return;

      const status = String(p.status || '');
      const phase = String(p.phase || '');
      const phaseIndex = typeof p.phaseIndex === 'number' ? p.phaseIndex : null;
      const phaseTotal = typeof p.phaseTotal === 'number' ? p.phaseTotal : null;
      const strategy = typeof p.strategy === 'string' ? p.strategy : '';
      const received = typeof p.receivedMessages === 'number' ? p.receivedMessages : (typeof p.messages === 'number' ? p.messages : 0);
      const total = typeof p.totalMessages === 'number' ? p.totalMessages : null;
      const chunks = typeof p.receivedChunks === 'number' ? p.receivedChunks : null;
      const totalChunks = typeof p.totalChunks === 'number' ? p.totalChunks : null;

      let line = '';
      // Only show % when total is reliable and coherent (avoid 100% (827/425) nonsense).
      if (total && total > 0 && received >= 0 && received <= total) {
        const pct = Math.min(100, Math.max(0, Math.floor((received / total) * 100)));
        line = `Progress: ${pct}% (${received}/${total} msgs)`;
      } else if (totalChunks && chunks !== null) {
        const pct = Math.min(100, Math.max(0, Math.floor((chunks / totalChunks) * 100)));
        line = `Progress: ${pct}% (chunks ${chunks}/${totalChunks})`;
      } else if (received > 0) {
        line = `Progress: ${received} msgs captured…`;
      }

      const phaseLabel = phase
        ? (phaseIndex && phaseTotal ? `Phase ${phaseIndex}/${phaseTotal}: ${phase}` : `Phase: ${phase}`)
        : '';
      const strategyLabel = strategy ? `Mode: ${strategy}` : '';
      const lines = [strategyLabel, phaseLabel, line].filter(Boolean).join('\n');
      if (status && status !== 'done' && status !== 'error') {
        setBusy(true);
        showStatus('loading', `Extracting conversation...\n\n${lines || 'Working…'}`);
      }

      if (status === 'done') {
        stopProgressPoll();
        setBusy(false);
        if (typeof onDone === 'function') onDone(p);
      }
      if (status === 'error') {
        stopProgressPoll();
        setBusy(false);
        if (typeof onError === 'function') onError(p);
      }
    } catch (_) {
      // ignore
    }
  }, 250);
}

/**
 * Initialize popup UI and event listeners
 */
document.addEventListener('DOMContentLoaded', async () => {
  const generateBtn = document.getElementById('generateBtn');
  const viewRawBtn = document.getElementById('viewRawBtn');
  const copyPromptBtn = document.getElementById('copyPromptBtn');
  const copyEncoderPromptBtn = document.getElementById('copyEncoderPromptBtn');
  const finalizeBlocksBtn = document.getElementById('finalizeBlocksBtn');
  const rl4BlocksInput = document.getElementById('rl4BlocksInput');
  const copyLastPromptBtn = document.getElementById('copyLastPromptBtn');
  const toggleLastPromptBtn = document.getElementById('toggleLastPromptBtn');
  const optionsToggleBtn = document.getElementById('optionsToggleBtn');
  const reloadBtn = document.getElementById('reloadBtn');
  const modeCompactEl = document.getElementById('modeCompact');
  const modeUltraPlusEl = document.getElementById('modeUltraPlus');
  const modeTranscriptEl = document.getElementById('modeTranscript');
  const integrityEl = document.getElementById('integritySeal');
  const metaToggleBtn = document.getElementById('metaToggleBtn');
  // URL input removed (simplifies UX); we always target the active supported tab.
  setBusy(false);

  // UX: At rest, only "Generate Context" should be actionable.
  setPostActionsEnabled(false);
  setLastPromptExpanded(false);
  setOptionsExpanded(false);
  setMetaExpanded(false);
  refreshGuidance().catch(() => {});
  refreshLastPromptControls();

  // Restore sticky flow state (sequence must not "stop" until Reload).
  try {
    const f = await loadUiFlow();
    if (f && f.active === true) {
      flowSticky = true;
      // If user was in the middle of Step 2/3, keep the paste container visible.
      document.getElementById('rl4BlocksManual')?.classList.remove('hidden');
    }
  } catch (_) {}

  reloadBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    await resetUiForNewRun();
  });

  optionsToggleBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    setOptionsExpanded(!optionsExpanded);
  });

  metaToggleBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    setMetaExpanded(!metaExpanded);
  });

  // Restore and display last prompt (persisted) so closing the popup doesn't lose it.
  try {
    const last = await loadLastPrompt();
    cachedLastPrompt = last;
    renderLastPrompt(last);
  } catch (_) {
    // ignore
  }
  refreshLastPromptControls();

  // Restore last snapshot (if any) to re-enable "View raw JSON" and "Copy prompt"
  try {
    const lastSnap = await loadLastSnapshot();
    if (lastSnap) {
      currentSnapshot = lastSnap;
      hasSnapshotInThisUiSession = true;
      setPostActionsEnabled(true);
      updateMetadata(lastSnap);
      initChunkEncoderFromSnapshot(lastSnap).catch(() => {});
      renderLastPrompt(cachedLastPrompt);
      setLastPromptExpanded(false);
      refreshGuidance().catch(() => {});
      refreshLastPromptControls();
    }
    const lastPrompt = await loadLastPrompt();
    if (!lastPrompt && lastSnap) {
      const prompt = buildInjectionPrompt(lastSnap);
      await saveLastPrompt(prompt);
      cachedLastPrompt = prompt;
      renderLastPrompt(prompt);
    }
  } catch (_) {
    // ignore
  }

  // If a job is currently running, show spinner + progress even after reopening popup.
  try {
    const activeTab = await getTargetActiveTab();
    const activeTabId = activeTab && typeof activeTab.id === 'number' ? activeTab.id : null;
    const res = await chrome.storage.local.get([STORAGE_KEYS.CAPTURE_PROGRESS]);
    const p = res && res[STORAGE_KEYS.CAPTURE_PROGRESS] && typeof res[STORAGE_KEYS.CAPTURE_PROGRESS] === 'object'
      ? res[STORAGE_KEYS.CAPTURE_PROGRESS]
      : null;
    const now = Date.now();
    // Captures can run for minutes (virtualized hydration on huge chats).
    // Keep the UI attached even if the last progress tick is older than 30s.
    const isFresh = p && typeof p.updatedAt === 'number' ? now - p.updatedAt < 10 * 60_000 : false;
    const matchesTab = activeTabId !== null && p && typeof p.tabId === 'number' ? p.tabId === activeTabId : false;
    if (p && p.status && p.status !== 'done' && p.status !== 'error' && matchesTab && isFresh) {
      startProgressPoll(p.captureId || null, {
        onDone: async () => {
          const snap = await loadLastSnapshot();
          if (snap) {
            currentSnapshot = snap;
            updateMetadata(snap);
            showStatus('success', 'Ready. Snapshot finished in background.');
            hasSnapshotInThisUiSession = true;
            setPostActionsEnabled(true);
            refreshGuidance().catch(() => {});
          }
        },
        onError: (pp) => {
          showStatus('error', `Capture error: ${pp && pp.error ? pp.error : 'Unknown error'}`);
        }
      });
    } else {
      // No running job for this tab → spinner off.
      setBusy(false);
    }
  } catch (_) {
    // ignore
  }

  copyLastPromptBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    // Regenerate from the latest snapshot so provider-specific handoff (e.g. Copilot) is respected.
    const tab = await getTargetActiveTab().catch(() => null);
    const tabId = tab && typeof tab.id === 'number' ? tab.id : null;
    const snap =
      tabId !== null ? await loadSnapshotForTabOrGlobal(tabId).catch(() => null) : await loadLastSnapshot().catch(() => null);
    if (!snap) return;
    const provider = await detectHandoffProviderFromActiveTabOrSnapshot(snap);
    const prompt = buildInjectionPrompt(snap, { provider });
    await copyToClipboard(prompt);
    // Persist so "Last prompt" matches what we actually copied.
    try {
      await saveLastPrompt(prompt);
      cachedLastPrompt = prompt;
      renderLastPrompt(prompt);
      refreshLastPromptControls();
    } catch (_) {}
    showStatus('success', '✓ Copied to clipboard.');
    flashOnce(copyLastPromptBtn);
    flashOnce(document.getElementById('lastPrompt'), 'rl4-highlight', 1100);
  });

  // Last prompt toggle button (explicit, easier to understand than click-anywhere).
  toggleLastPromptBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    const wrap = document.getElementById('lastPrompt');
    const expanded = wrap && wrap.dataset && wrap.dataset.expanded === 'true';
    setLastPromptExpanded(!expanded);
  });

  generateBtn.addEventListener('click', generateSnapshot);
  // Optional debug link (may be absent in the stage-based UI)
  viewRawBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    if (currentSnapshot) {
      showRawJSON(currentSnapshot);
    }
  });
  copyPromptBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!currentSnapshot) return;
    // Provider-sensitive handoff prompt (Copilot needs a "reference document" framing).
    let provider = '';
    try {
      const tab = await getTargetActiveTab();
      const url = typeof tab?.url === 'string' ? tab.url : '';
      const host = url ? new URL(url).hostname.toLowerCase() : '';
      if (host === 'copilot.microsoft.com') provider = 'copilot';
    } catch (_) {}
    if (!provider) {
      try {
        const p = String(currentSnapshot?.metadata?.capture_provider || '').toLowerCase();
        if (p === 'copilot') provider = 'copilot';
      } catch (_) {}
    }
    const prompt = buildInjectionPrompt(currentSnapshot, { provider });
    await copyToClipboard(prompt);
    flashOnce(copyPromptBtn);
    flashOnce(document.getElementById('lastPrompt'), 'rl4-highlight', 1100);
    // Micro feedback: temporary label swap
    const old = copyPromptBtn.textContent;
    copyPromptBtn.textContent = 'Copied!';
    setTimeout(() => {
      if (copyPromptBtn) copyPromptBtn.textContent = old || 'Copy Final Prompt';
    }, 900);
    showStatus('success', 'Copied to clipboard.\n\nPaste it into another LLM to resume with memory.\n\nTip: your last final prompt is saved below.');
    refreshGuidance().catch(() => {});
  });

  copyEncoderPromptBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!currentSnapshot) return;
    try {
      // Some providers (notably Perplexity) treat very large pasted text as "file analysis" and ignore
      // strict output-format instructions. To keep the encoder prompt reliable across providers,
      // we drop transcript_compact when it's too large or when running on Perplexity.
      const activeTab = await getTargetActiveTab();
      const url = typeof activeTab?.url === 'string' ? activeTab.url : '';
      let host = '';
      try {
        host = url ? new URL(url).hostname.toLowerCase() : '';
      } catch (_) {
        host = '';
      }
      const isPerplexity = host.endsWith('perplexity.ai');
      const isCopilot = host === 'copilot.microsoft.com';

      // Copilot reliably refuses “protocol-like” templating. For Copilot we generate RL4 blocks locally
      // from the snapshot (no LLM), seal them via the content script, and jump to Step 4.
      if (isCopilot) {
        showStatus('loading', 'Copilot mode: generating final blocks locally…');
      const tab = await getTargetActiveTab();
        if (!tab || typeof tab.id !== 'number') throw new Error('No active tab found.');
        await waitForContentScript(tab.id);

        const localBlocks = buildLocalRl4BlocksText(currentSnapshot);
        chrome.tabs.sendMessage(tab.id, { action: 'finalizeRl4BlocksManual', text: localBlocks }, async (resp) => {
          if (chrome.runtime.lastError) {
            showStatus('error', `Finalize error: ${chrome.runtime.lastError.message || 'Unknown error'}`);
            return;
          }
          if (!resp || resp.ok !== true) {
            showStatus('error', `Finalize error: ${resp && resp.error ? resp.error : 'Unknown error'}`);
            return;
          }
      startRl4BlocksPoll({
        onSealed: async () => {
          try {
            const snap = await loadLastSnapshot();
                if (snap) currentSnapshot = snap;
              } catch (_) {}
              flowSticky = false;
              showStatus('success', 'Finalized ✓\n\nNow copy the final prompt (Step 4).');
              updateMetadata(currentSnapshot);
              saveUiFlow({ active: true, step: 'sealed', updatedAt: Date.now() }).catch(() => {});
              try {
                setGuidanceStep('copy_final');
              } catch (_) {}
              refreshGuidance().catch(() => {});
            }
          });
        });

        // Ensure UI moves forward even if sealing takes a moment.
        try {
          setGuidanceStep('copy_final');
          } catch (_) {}
        return;
      }

      let snapForEncoder = currentSnapshot;
      const transcript =
        typeof snapForEncoder?.transcript_compact === 'string' ? snapForEncoder.transcript_compact : '';
      // Hard cap to avoid "attachment/file mode" behavior in web UIs.
      const shouldDropTranscript = isPerplexity || isCopilot || (transcript && transcript.length > 50_000);
      if (shouldDropTranscript && snapForEncoder && typeof snapForEncoder === 'object') {
        snapForEncoder = { ...snapForEncoder };
        delete snapForEncoder.transcript_compact;
      }

      const prompt = buildRl4BlocksEncoderPrompt(snapForEncoder, { provider: isCopilot ? 'copilot' : '' });
      await copyToClipboard(prompt);

      // Sticky sequence: once Step 2 starts, keep Step 3 visible until Reload.
      flowSticky = true;
      saveUiFlow({ active: true, step: 'await_response', updatedAt: Date.now() }).catch(() => {});

      // Persist "awaiting" in storage so guidance can reliably move to Step 3 immediately.
      try {
        await chrome.storage.local.set({
          [STORAGE_KEYS.RL4_BLOCKS_STATUS]: { status: 'awaiting', updatedAt: Date.now() }
        });
      } catch (_) {
        // ignore
      }

      renderRl4BlocksStatus({ status: 'awaiting' });
      flowSticky = true;
      // NOTE: auto-capture is intentionally disabled (prevents stale/previous replies from being re-used).

      showStatus('success', 'Copied to clipboard!\n\nPaste it into your current chat and send it.\n\nThen paste the LLM response here to finalize.');

      try {
        // Move immediately to Step 3 UI (stable, stage-based).
        setGuidanceStep('paste_response');
        const ta = document.getElementById('rl4BlocksInput');
        if (ta && typeof ta.focus === 'function') ta.focus();
      } catch (_) {}

      refreshGuidance().catch(() => {});
    } catch (err) {
      showStatus('error', `Encoder copy failed: ${err && err.message ? err.message : String(err)}`);
    }
  });

  // Chunk encoder (for long chats)
  const chunkToggleBtn = document.getElementById('chunkToggleBtn');
  const chunkIndexInput = document.getElementById('chunkIndexInput');
  const copyChunkPromptBtn = document.getElementById('copyChunkPromptBtn');
  const saveChunkNotesBtn = document.getElementById('saveChunkNotesBtn');
  const copyMergePromptBtn = document.getElementById('copyMergePromptBtn');
  const chunkNotesInput = document.getElementById('chunkNotesInput');

  chunkToggleBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    setChunkExpanded(!chunkExpanded);
  });

  chunkIndexInput?.addEventListener('input', () => {
    loadChunkNotesIntoTextarea();
  });

  copyChunkPromptBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!currentSnapshot) return;
    if (!chunkConvKey) return;
    const total = Array.isArray(chunkPlan) ? chunkPlan.length : 0;
    const idx1 = chunkIndexInput ? parseInt(chunkIndexInput.value, 10) || 1 : 1;
    const ix = Math.max(1, Math.min(total || 1, idx1)) - 1;
    const res = await bgSend({
      action: 'rl4_transcript_get_chunk_prompt',
      convKey: chunkConvKey,
      chunk_index: ix,
      max_chars: chunkMaxChars
    });
    if (!res || res.ok !== true || typeof res.prompt !== 'string') {
      showStatus('error', `Chunk prompt failed: ${res && res.error ? res.error : 'Unknown error'}`);
      return;
    }
    await copyToClipboard(res.prompt);
    setChunkExpanded(true);
    showStatus('success', `Chunk ${ix + 1}/${res.chunkTotal} prompt copied.\n\nPaste it into the LLM and send it. Then paste the reply into “chunk notes”.`);
    try {
      chunkNotesInput?.focus?.();
    } catch (_) {}
  });

  saveChunkNotesBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!chunkConvKey) return;
    const total = Array.isArray(chunkPlan) ? chunkPlan.length : 0;
    const idx1 = chunkIndexInput ? parseInt(chunkIndexInput.value, 10) || 1 : 1;
    const ix = Math.max(1, Math.min(total || 1, idx1)) - 1;
    const text = chunkNotesInput ? String(chunkNotesInput.value || '').trim() : '';
    if (!Array.isArray(chunkNotes)) chunkNotes = [];
    if (chunkNotes.length < total) chunkNotes = [...chunkNotes, ...new Array(total - chunkNotes.length).fill('')];
    chunkNotes[ix] = text;
    const saveRes = await bgSend({ action: 'rl4_chunk_notes_save', convKey: chunkConvKey, notes: chunkNotes });
    if (!saveRes || saveRes.ok !== true) {
      showStatus('error', `Save failed: ${saveRes && saveRes.error ? saveRes.error : 'Unknown error'}`);
      return;
    }
    updateChunkPlanInfo();
    showStatus('success', `Saved chunk notes (${ix + 1}/${total}).`);
  });

  copyMergePromptBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!chunkConvKey) return;
    const total = Array.isArray(chunkPlan) ? chunkPlan.length : 0;
    const saved = Array.isArray(chunkNotes) ? chunkNotes.filter((x) => String(x || '').trim().length > 0).length : 0;
    if (!total || saved === 0) {
      showStatus('warning', 'No chunk notes saved yet.');
      return;
    }
    const mergeRes = await bgSend({
      action: 'rl4_transcript_get_merge_prompt',
      chunk_notes: Array.isArray(chunkNotes) ? chunkNotes.filter((x) => String(x || '').trim().length > 0) : []
    });
    if (!mergeRes || mergeRes.ok !== true || typeof mergeRes.prompt !== 'string') {
      showStatus('error', `Merge prompt failed: ${mergeRes && mergeRes.error ? mergeRes.error : 'Unknown error'}`);
      return;
    }
    await copyToClipboard(mergeRes.prompt);
    showStatus('success', `Merge prompt copied.\n\nPaste it into the LLM to get final RL4 blocks, then use “Create finalization prompt” flow.`);
  });

  finalizeBlocksBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    const raw = rl4BlocksInput ? String(rl4BlocksInput.value || '').trim() : '';
    if (!raw) {
      showStatus('warning', 'Step 3/ Paste the LLM response first.');
      return;
    }
    try {
      const tab = await getTargetActiveTab();
      if (!tab || typeof tab.id !== 'number') throw new Error('No active tab found.');

      const normalized = normalizeRl4BlocksText(raw);
      // Keep the UI consistent with what we will actually finalize.
      try {
        if (rl4BlocksInput) rl4BlocksInput.value = normalized;
      } catch (_) {}

      showStatus('loading', 'Finalizing snapshot…');
      chrome.tabs.sendMessage(
        tab.id,
        { action: 'finalizeRl4BlocksManual', text: normalized },
        async (resp) => {
          if (chrome.runtime.lastError) {
            showStatus('error', `Finalize error: ${chrome.runtime.lastError.message || 'Unknown error'}`);
            return;
          }
          if (!resp || resp.ok !== true) {
            showStatus('error', `Finalize error: ${resp && resp.error ? resp.error : 'Unknown error'}`);
            return;
          }
          startRl4BlocksPoll({
            onSealed: async () => {
              const snap = await loadLastSnapshot();
              if (snap) currentSnapshot = snap;
              // After finalize: keep UX dead-simple (only Step 4 CTA).
              flowSticky = false;
              showStatus('success', 'Finalized ✓\n\nNow copy the final prompt (Step 4).');
              updateMetadata(currentSnapshot);
              saveUiFlow({ active: true, step: 'sealed', updatedAt: Date.now() }).catch(() => {});
              // Move immediately to Step 4 (even before the next guidance tick).
              try {
                setGuidanceStep('copy_final');
              } catch (_) {}
              refreshGuidance().catch(() => {});
            }
          });
        }
      );
    } catch (err) {
      showStatus('error', `Finalize failed: ${err && err.message ? err.message : String(err)}`);
    }
  });

  rl4BlocksInput?.addEventListener('input', () => {
    updateFinalizeButtonState();
    refreshGuidance().catch(() => {});
  });

  // Mode radios: keep a safe default if none is selected (shouldn't happen).
  const syncMode = () => {
    const any =
      (modeCompactEl && modeCompactEl.checked) ||
      (modeUltraPlusEl && modeUltraPlusEl.checked) ||
      (modeTranscriptEl && modeTranscriptEl.checked);
    if (!any && modeCompactEl) modeCompactEl.checked = true;
  };
  modeCompactEl?.addEventListener('change', syncMode);
  modeUltraPlusEl?.addEventListener('change', syncMode);
  modeTranscriptEl?.addEventListener('change', syncMode);
  syncMode();

  // On open, show RL4 blocks status if an encode is in progress / completed.
  try {
    const s = await loadRl4BlocksStatus();
    renderRl4BlocksStatus(s);
    refreshGuidance().catch(() => {});
    if (s && (s.status === 'awaiting' || s.status === 'captured')) {
      // Keep manual container visible to avoid flicker/disappearance when awaiting/captured.
      document.getElementById('rl4BlocksManual')?.classList.remove('hidden');
      flowSticky = true;
      startRl4BlocksPoll();
    }
  } catch (_) {
    // ignore
  }
});

/**
 * Normalizes common provider quirks in RL4 blocks without "inventing" content.
 * - Converts "patterns:" → "patterns=" (same for correlations/risks/recommendations) inside <RL4-INSIGHTS>
 * - Converts "validated_intents:" → "validated_intents=" (etc.) inside <RL4-DECISIONS>
 * - Rewrites <RL4-TOPICS>none</RL4-TOPICS> → NOT_AVAILABLE
 * - Removes markdown bold around HUMAN SUMMARY header
 * - Truncates anything after the first <RL4-END/> token
 */
function normalizeRl4BlocksText(input) {
  let text = String(input || '');

  // Drop anything after the first end token (providers sometimes add citations/footnotes after).
  const endToken = '<RL4-END/>';
  const endIx = text.indexOf(endToken);
  if (endIx !== -1) {
    text = text.slice(0, endIx + endToken.length);
  }

  // Normalize HUMAN SUMMARY header formatting.
  text = text.replace(/\*\*\s*HUMAN SUMMARY\s*\*\*/gi, 'HUMAN SUMMARY');

  const replaceTagInner = (tag, replacer) => {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
    return text.replace(re, (m, inner) => `<${tag}>${replacer(String(inner || ''))}</${tag}>`);
  };

  // Normalize RL4-ARCH: accept "key=value" pairs but seal as "key:value".
  // Keep "=" reserved for DECISIONS/INSIGHTS KV pairs.
  text = replaceTagInner('RL4-ARCH', (inner) => String(inner || '').replace(/([a-zA-Z_]+)\s*=\s*/g, '$1:'));

  text = replaceTagInner('RL4-INSIGHTS', (inner) =>
    inner.replace(/\b(patterns|correlations|risks|recommendations)\s*:\s*/gi, (m, k) => `${k.toLowerCase()}=`)
  );

  text = replaceTagInner('RL4-DECISIONS', (inner) =>
    inner.replace(/\b(validated_intents|rejected|constraints|control_style)\s*:\s*/gi, (m, k) => `${k.toLowerCase()}=`)
  );

  text = replaceTagInner('RL4-TOPICS', (inner) => {
    const t = String(inner || '').trim();
    if (!t) return 'NOT_AVAILABLE';
    if (t.toLowerCase() === 'none') return 'NOT_AVAILABLE';
    return inner;
  });

  return text.trim();
}

/**
 * Main snapshot generation flow
 */
async function generateSnapshot() {
  const generateBtn = document.getElementById('generateBtn');
  const statusDiv = document.getElementById('status');
  const metadataDiv = document.getElementById('metadata');
  const modeCompactEl = document.getElementById('modeCompact');
  const modeUltraPlusEl = document.getElementById('modeUltraPlus');
  const modeTranscriptEl = document.getElementById('modeTranscript');
  const integrityEl = document.getElementById('integritySeal');

  try {
    // Reset UI
    generateBtn.disabled = true;
    metadataDiv.classList.add('hidden');
    setPostActionsEnabled(false);
    setBusy(true);
    showStatus('loading', 'Starting capture… (runs in background)');

    // IMPORTANT: always clear blocks state when generating a new snapshot (even if user didn't click Reload).
    // This prevents accidentally reusing a previous LLM reply when switching modes.
    try {
      await chrome.storage.local.remove([STORAGE_KEYS.RL4_BLOCKS, STORAGE_KEYS.RL4_BLOCKS_STATUS, STORAGE_KEYS.UI_FLOW]);
    } catch (_) {}
    try {
      flowSticky = false;
      renderRl4BlocksStatus(null);
      const ta = document.getElementById('rl4BlocksInput');
      if (ta) {
        ta.value = '';
        ta.disabled = false;
      }
    } catch (_) {}

    // Get target tab (provider tab even if RL4 UI is detached)
    const activeTab = await getTargetActiveTab();
    const mode = modeTranscriptEl && modeTranscriptEl.checked
      ? 'transcript'
      : modeUltraPlusEl && modeUltraPlusEl.checked
        ? 'ultra_plus'
        : 'compact';

    // Modes:
    // - compact: digest, no transcript
    // - ultra_plus: ultra_plus, no transcript
    // - transcript: digest + transcript
    const outputMode = mode === 'ultra_plus' ? 'ultra_plus' : 'digest';
    const includeTranscript = mode === 'transcript';
    // URL input removed: always operate on the active/remembered supported tab.
    const tab = await resolveTargetTab(activeTab, '');
    
    await waitForContentScript(tab.id);
    const captureId = `cap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const wantsIntegritySeal = integrityEl ? !!integrityEl.checked : false;

    // Poll progress and auto-load snapshot when job finishes (if popup stays open).
    startProgressPoll(captureId, {
      onDone: async (p) => {
        // IMPORTANT: CAPTURE_PROGRESS + LAST_SNAPSHOT are global. With multiple provider tabs open,
        // the "last snapshot" can be overwritten by another tab. Prefer the snapshot stored for
        // the tabId that actually completed this capture.
        const tabId = p && typeof p.tabId === 'number' ? p.tabId : tab.id;
        const snap = await loadSnapshotForTabOrGlobal(tabId);
        if (!snap) {
          showStatus('warning', 'Capture finished, but no snapshot found. Reopen the popup and try again.');
          setBusy(false);
          return;
        }
        currentSnapshot = snap;
        updateMetadata(snap);
        hasSnapshotInThisUiSession = true;
        setPostActionsEnabled(true);
        initChunkEncoderFromSnapshot(snap).catch(() => {});
        refreshLastPromptControls();

        const prompt = buildInjectionPrompt(snap);
        try {
          await saveLastPrompt(prompt);
        } catch (_) {}
        cachedLastPrompt = prompt;
        renderLastPrompt(prompt);
        setLastPromptExpanded(false);

        const msgCount = snap.metadata?.messages || snap.metadata?.total_messages || 0;
        const provider = String(snap.metadata?.capture_provider || '').toLowerCase();
        const strategy = String(snap.metadata?.capture_strategy || '').toLowerCase();
        const completeness = String(snap.metadata?.capture_completeness || '').toLowerCase();
        const partialHint =
          completeness === 'partial'
            ? '\n\nNOTE: Capture may be partial (API pagination signaled more history).'
            : (provider === 'chatgpt' || provider === 'claude') && strategy === 'dom'
              ? '\n\nNOTE: Capture may be partial on this provider (virtualized history).'
              : '';
    showStatus(
      'success',
          `Step 1/ Done.\n\nStep 2/ Copy the finalization prompt.${partialHint}`
        );
        setBusy(false);
        refreshGuidance().catch(() => {});
      },
      onError: (p) => {
        showStatus('error', `Capture error: ${p && p.error ? p.error : 'Unknown error'}`);
        setBusy(false);
        refreshGuidance().catch(() => {});
      }
    });

    showStatus('loading', 'Capture running in background.\n\nYou can close this popup and come back later.');
    setGuidanceStep('generate');
    chrome.tabs.sendMessage(
      tab.id,
      {
        action: 'startSnapshotJob',
        captureId,
        options: { outputMode, includeTranscript, wantsIntegritySeal }
      },
      (resp) => {
        if (chrome.runtime.lastError) {
          showStatus('error', `Error: ${chrome.runtime.lastError.message || 'Failed to start capture job'}`);
          stopProgressPoll();
          setBusy(false);
          return;
        }
        if (!resp || resp.ok !== true) {
          const msg = resp && resp.error && resp.error.message ? resp.error.message : 'Failed to start snapshot job.';
          showStatus('error', `Error: ${msg}`);
          stopProgressPoll();
          setBusy(false);
        }
      }
    );

    // If we opened a temporary tab, close it.
    if (tab && tab.__rl4_temp === true) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (_) {
        // ignore
      }
    }

  } catch (error) {
    console.error('[RL4] Error generating snapshot:', error);
    showStatus('error', `Error: ${error.message || 'Failed to generate context'}`);
    setBusy(false);
  } finally {
    generateBtn.disabled = false;
  }
}

function buildInjectionPrompt(snapshot, { provider = '' } = {}) {
  const transcript = typeof snapshot?.transcript_compact === 'string' ? snapshot.transcript_compact : '';
  const hasTranscript = transcript.length > 0;
  // Hard cap: avoid pasting massive transcripts that some providers treat as "file analysis"/attachments.
  // Keep transcript_ref + transcript_sha256 as pointers for later retrieval / chunking.
  const shouldDropTranscript = hasTranscript && transcript.length > 50_000;
  const protocol = snapshot && snapshot.protocol ? snapshot.protocol : 'RCEP_v1';
  const hasSig = snapshot && snapshot.signature && typeof snapshot.signature === 'object';
  const providerHint = String(provider || '').toLowerCase();

  const snapForPrompt =
    shouldDropTranscript && snapshot && typeof snapshot === 'object'
      ? (() => {
          const s = { ...snapshot };
          delete s.transcript_compact;
          return s;
        })()
      : snapshot;

  // Copilot: avoid “memory handoff / protocol / instructions” framing. Treat as a user-provided reference document.
  if (providerHint === 'copilot') {
    const summary =
      String(snapshot?.context_summary_ultra || snapshot?.context_summary || snapshot?.context_state?.current_goal || '').trim() ||
      'NOT_AVAILABLE';
    return (
      `REFERENCE CONTEXT (user-provided)\n` +
      `Use the information below as a reference to continue the conversation.\n` +
      `If something is missing, ask a short clarifying question before proceeding.\n\n` +
      `Quick summary:\n${summary}\n\n` +
      `REFERENCE_JSON:\n` +
      `${JSON.stringify(snapForPrompt, null, 2)}\n`
    );
  }

  return (
    `*** RL4 MEMORY HANDOFF (Cross‑LLM) ***\n` +
    `Protocol family: RCEP™\n` +
    `Protocol version: ${protocol}\n` +
    (hasSig ? `Integrity: Tamper-sealed (device-only)\n` : `Integrity: Unsealed\n`) +
    `\n` +
    `[INSTRUCTIONS FOR THE AI]\n` +
    `- This is a cross‑LLM memory handoff. Continue from it.\n` +
    `- Use "portable_memory" first (human handoff). Use "semantic_spine"/"cognitive_spine" for details.\n` +
    `- Treat the JSON below as ground truth (structure).\n` +
    `- Do not assume missing facts; ask targeted questions if needed.\n` +
    `- IMPORTANT: Integrity can be verified, but semantic correctness may be unverified.\n` +
    (hasSig
      ? `- If "signature" is present, do not edit this JSON. If verification fails, treat it as tampered.\n` +
        `- NOTE: "Tamper-sealed" means mutation detection, NOT semantic validation.\n`
      : '') +
    `\n` +
    (hasTranscript
      ? shouldDropTranscript
        ? `Transcript: Not included (too large). Use transcript_ref + transcript_sha256 as pointers.\n`
        : `Transcript: Included (full fidelity).\n`
      : `Transcript: Not included (token-saver). Fingerprint available under "conversation_fingerprint".\n`) +
    `\n` +
    `CONTEXT_JSON:\n` +
    `${JSON.stringify(snapForPrompt, null, 2)}\n` +
    `\n` +
    `*** Generated by RL4 Snapshot (RCEP™) ***\n`
  );
}

function buildRl4BlocksEncoderPrompt(snapshot, { provider = '' } = {}) {
  const protocol = snapshot && snapshot.protocol ? snapshot.protocol : 'RCEP_v1';
  const hasSig = snapshot && snapshot.signature && typeof snapshot.signature === 'object';
  const hasTranscript = typeof snapshot?.transcript_compact === 'string' && snapshot.transcript_compact.length > 0;
  const hasCognitiveDays = Array.isArray(snapshot?.cognitive_days) && snapshot.cognitive_days.length > 0;
  const hasCausalChains = Array.isArray(snapshot?.causal_chains_v2) && snapshot.causal_chains_v2.length > 0;
  const hasProgressiveSummary = snapshot?.progressive_summary && typeof snapshot.progressive_summary === 'object';
  const providerHint = String(provider || '').toLowerCase();

  // Copilot sometimes refuses prompts that look like "external protocols" or "system-like directives".
  // This variant keeps the same tags, but frames it as a user-requested output template (no "protocol/system" language).
  if (providerHint === 'copilot') {
    return (
      `Please fill the following plain-text template using ONLY the JSON below.\n` +
      `- Do not mention policies or internal rules.\n` +
      `- Do not add introductions, explanations, or extra sections.\n` +
      `- If something is not supported by the JSON, write NOT_AVAILABLE.\n` +
      `- Start directly with <RL4-ARCH>.\n\n` +
      `<RL4-ARCH>phase:NOT_AVAILABLE|compress:${String(snapshot?.metadata?.compression_digest || snapshot?.metadata?.compression_ratio || snapshot?.metadata?.compression_bundle || 'NOT_AVAILABLE')}|protocol:${protocol}</RL4-ARCH>\n` +
      `<RL4-LAYERS>NOT_AVAILABLE</RL4-LAYERS>\n` +
      `<RL4-TOPICS>NOT_AVAILABLE</RL4-TOPICS>\n` +
      `<RL4-TIMELINE>NOT_AVAILABLE|VELOCITY:NOT_AVAILABLE|CLARITY:NOT_AVAILABLE|DECISIONS:NOT_AVAILABLE</RL4-TIMELINE>\n` +
      `<RL4-DECISIONS>validated_intents=NOT_AVAILABLE|rejected=[]|constraints=NOT_AVAILABLE|control_style=NOT_AVAILABLE</RL4-DECISIONS>\n` +
      `<RL4-INSIGHTS>patterns=NOT_AVAILABLE correlations=NOT_AVAILABLE risks=NOT_AVAILABLE recommendations=NOT_AVAILABLE</RL4-INSIGHTS>\n` +
      `<RL4-COGNITIVE-DAYS>NOT_AVAILABLE</RL4-COGNITIVE-DAYS>\n` +
      `<RL4-CAUSAL-CHAINS>NOT_AVAILABLE</RL4-CAUSAL-CHAINS>\n` +
      `<RL4-PROGRESSIVE>L1:NOT_AVAILABLE|L2:NOT_AVAILABLE</RL4-PROGRESSIVE>\n` +
      `HUMAN SUMMARY:\n` +
      `NOT_AVAILABLE\n` +
      `<RL4-END/>\n\n` +
      `CONTEXT_JSON:\n` +
      `${JSON.stringify(snapshot, null, 2)}\n`
    );
  }

  // Build cognitive blocks guidance for V2.0
  const cognitiveBlocksGuidance = 
    `\nCOGNITIVE BLOCKS (NEW - V2.0)\n` +
    `These blocks help LLMs "deduce" context instead of keyword-searching.\n\n` +
    `8) <RL4-COGNITIVE-DAYS>day_id:focus:key_shift|...</RL4-COGNITIVE-DAYS>\n` +
    `   - Extract from cognitive_days[] if present in JSON\n` +
    `   - Format: day-1:topic1,topic2:initial|day-2:topic3:shift to X\n` +
    `   - If not present, derive from timeline_macro phases\n\n` +
    `9) <RL4-CAUSAL-CHAINS>chain_id:trigger→decision→outcome(score)|...</RL4-CAUSAL-CHAINS>\n` +
    `   - Extract from causal_chains_v2[] if present\n` +
    `   - Format: chain-1:problem X→chose Y→implemented(0.8)\n` +
    `   - Impact scores help prioritize what matters\n\n` +
    `10) <RL4-PROGRESSIVE>L1:glance|L2:context</RL4-PROGRESSIVE>\n` +
    `   - Extract from progressive_summary if present\n` +
    `   - L1: 1 sentence max 100 chars (quick glance)\n` +
    `   - L2: 3-5 sentences max 500 chars (working context)\n`;

  // Source hints based on what's available
  const cognitiveSourceHints = 
    (hasCognitiveDays ? `- cognitive_days[] is present with ${snapshot.cognitive_days.length} days. USE IT for <RL4-COGNITIVE-DAYS>.\n` : '') +
    (hasCausalChains ? `- causal_chains_v2[] is present with ${snapshot.causal_chains_v2.length} chains. USE IT for <RL4-CAUSAL-CHAINS>.\n` : '') +
    (hasProgressiveSummary ? `- progressive_summary is present. USE L1/L2 for <RL4-PROGRESSIVE>.\n` : '');

  return (
    `RL4 Conversation Encoder — Cross‑LLM Memory (Ping‑Pong Aware + Cognitive V2.0)\n\n` +
    `You are given an RL4 Snapshot JSON (RCEP™). Your job is to produce a compact, human-usable RL4 BLOCKS output that preserves:\n` +
    `- validated direction (what the user kept)\n` +
    `- drift guards (what was rejected / non-negotiables)\n` +
    `- how the user pilots the model (control style)\n` +
    `- where to resume (next steps + open questions)\n` +
    `- cognitive context (thematic days, causal chains, progressive summaries)\n\n` +
    `CRITICAL RULES\n` +
    `- ENCODE CONTENT, NOT METADATA.\n` +
    `- Do NOT narrate “user said / assistant replied”.\n` +
    `- Use the JSON fields as ground truth. Spend effort on extracting/deriving, not on outputting UNKNOWN.\n` +
    `- Do not invent missing facts.\n` +
    `- STRICT OUTPUT: plain text only. No Markdown (no "**", no headings, no bullets).\n` +
    `- ABSOLUTE START: Your very first characters MUST be "<RL4-ARCH>". Output NOTHING before it (no intro, no title, no whitespace).\n` +
    `- ABSOLUTE BAN: No emojis, no code fences, no backticks, no numbered/markdown headings, no extra sections.\n` +
    `- STRICT KV SEPARATOR: inside <RL4-DECISIONS> and <RL4-INSIGHTS>, use "=" (never ":").\n` +
    `- STRICT EMPTY VALUES: never output "none". If empty/unknown, use NOT_AVAILABLE.\n` +
    `\n` +
    `GROUNDING (MANDATORY DERIVATION)\n` +
    `- You MUST fill every field in the 10 blocks. "UNKNOWN" is DISALLOWED.\n` +
    `- If a field cannot be supported, write NOT_AVAILABLE (not UNKNOWN).\n` +
    `- Allowed sources (in order):\n` +
    `  1) Explicit: semantic_spine.*, decisions[], insights[], topics[], context_summary/context_summary_ultra\n` +
    `  2) Cognitive V2.0: cognitive_days[], causal_chains_v2[], progressive_summary\n` +
    `  3) Derive from topics[]: use label/weight/message_refs; co-occurrence via shared message_refs.\n` +
    `  4) Derive from timeline_macro[] or timeline_summary[]: use keywords/sequences/phases.\n` +
    `  5) Derive from transcript_compact (if present) for factual details.\n` +
    `  6) Derive from the encoder rules themselves for protocol constraints (e.g., "no invention", "structured blocks").\n` +
    `- DERIVATION IS NOT INVENTION: extracting patterns from topics/timeline is allowed.\n` +
    (cognitiveSourceHints ? `\nCOGNITIVE DATA AVAILABLE:\n${cognitiveSourceHints}` : '') +
    (hasTranscript
      ? `- Full transcript is present (transcript_compact).\n` +
        `  - CRITICAL: Do NOT switch to "file analysis" mode (e.g., "Analyse du fichier ..."). Ignore file/tool wrappers.\n` +
        `  - You MUST still output ONLY the 10 RL4 blocks + HUMAN SUMMARY + <RL4-END/>.\n` +
        `  - If you use transcript_compact for a factual detail, you MUST embed evidence INSIDE the blocks as: (EVIDENCE:"...") with a short quote ≤120 chars.\n`
      : `- Transcript is not present. Do NOT infer details. Use only structured fields above.\n`) +
    `- OUTPUT ONLY the 10 blocks + the human summary. NO extra recommendations, NO ads, NO extra sections.\n` +
    `- Any output outside the 10 blocks + HUMAN SUMMARY is a FAILURE.\n` +
    `- After the human summary, print exactly: <RL4-END/>\n` +
    (hasSig ? `- The JSON includes a device-only tamper seal. Do NOT edit it.\n` : '') +
    `\nOUTPUT FORMAT (MUST follow)\n` +
    `1) <RL4-ARCH>phase:<value>|key:value|...|compress:XXx</RL4-ARCH>\n` +
    `2) <RL4-LAYERS> ... </RL4-LAYERS>\n` +
    `3) <RL4-TOPICS> ... </RL4-TOPICS>\n` +
    `4) <RL4-TIMELINE> ... VELOCITY:..|CLARITY:..|DECISIONS:.. </RL4-TIMELINE>\n` +
    `5) <RL4-DECISIONS> ... include rejected:... </RL4-DECISIONS>\n` +
    `6) <RL4-INSIGHTS>patterns=... correlations=... risks=... recommendations=... </RL4-INSIGHTS>\n` +
    cognitiveBlocksGuidance +
    `\n11) HUMAN SUMMARY (plain text, 8–12 lines max)\n` +
    `   Then: <RL4-END/>\n\n` +
    `SPECIAL REQUIREMENTS (Ping‑Pong)\n` +
    `- In DECISIONS, separate: validated_intents, rejected, constraints/control_style.\n` +
    `- rejected MUST be [] when rejected_alternatives is empty or missing.\n` +
    `- validated_intents MUST be derived even if semantic_spine is empty:\n` +
    `  - Prefer semantic_spine.open_questions + semantic_spine.main_tension when present.\n` +
    `  - Else derive from topics[] (highest weights) OR timeline_macro[].summary keywords OR timeline_summary[].summary.\n` +
    `- constraints MUST be derived safely:\n` +
    `  - If JSON explicitly states constraints → use them.\n` +
    `  - Else use protocol constraints from this encoder (no invention, structured blocks) as constraints.\n` +
    `- control_style MUST be derived from timeline sequencing (e.g., ask→refine→encode) or from JSON summaries; else NOT_AVAILABLE.\n` +
    `- In INSIGHTS:\n` +
    `  - patterns MUST be derived from topics/timeline structure (co-occurrence + sequence). If none, NOT_AVAILABLE.\n` +
    `  - correlations MUST be derived ONLY from shared message_refs (topics) or repeated keyword pairs (timeline). If none, NOT_AVAILABLE.\n` +
    `  - risks and recommendations are GATED: only output if explicitly supported by summaries/questions; else NOT_AVAILABLE.\n` +
    `- Drift guards: only include "Do NOT re-propose rejected directions" when there are rejected_alternatives.\n\n` +
    `COGNITIVE BLOCKS REQUIREMENTS (V2.0)\n` +
    `- <RL4-COGNITIVE-DAYS>: If cognitive_days[] exists, extract day_id + focus + key_shift. Else derive from timeline phases.\n` +
    `- <RL4-CAUSAL-CHAINS>: If causal_chains_v2[] exists, extract chain summaries with impact scores. Else NOT_AVAILABLE.\n` +
    `- <RL4-PROGRESSIVE>: If progressive_summary exists, use L1 and L2 directly. Else derive L1 from context_summary (100 chars max).\n\n` +
    `ARCH VALUES\n` +
    `- compress MUST match the JSON compression field:\n` +
    `  - if protocol is RCEP_v1 and metadata.compression_digest exists → use it (e.g. 103.4x)\n` +
    `  - if metadata.compression_ratio exists → use it (e.g. 55.2x)\n` +
    `  - else use metadata.compression_bundle (e.g. 44.5x)\n\n` +
    `CONTEXT_JSON (protocol: ${protocol}):\n` +
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
}

/**
 * Device-only (offline) integrity signature for tamper-evidence.
 * - Generates a P-256 key pair on first use and stores it in IndexedDB (private key non-exportable).
 * - Signs the string "checksum:<hex>".
 * @param {string} checksumHex
 * @returns {Promise<{type:string, algo:string, key_id:string, public_key_spki:string, signed_payload:string, value:string}>}
 */
async function signChecksumDeviceOnly(checksumHex) {
  const checksum = String(checksumHex || '').trim();
  if (!checksum) throw new Error('Missing checksum for signature.');
  const { privateKey, keyId, publicKeySpkiB64 } = await getOrCreateDeviceSigningKey();
  const payload = `checksum:${checksum}`;
  const data = new TextEncoder().encode(payload);
  const sigBuf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
  const sigB64 = arrayBufferToBase64(sigBuf);
  return {
    type: 'device_integrity_v1',
    algo: 'ECDSA_P256_SHA256',
    key_id: keyId,
    public_key_spki: publicKeySpkiB64,
    signed_payload: payload,
    value: sigB64
  };
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(String(b64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function sha256HexBytes(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function openKeyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rl4_device_keys', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keys')) {
        db.createObjectStore('keys', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
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

async function idbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('IndexedDB put failed'));
  });
}

async function getOrCreateDeviceSigningKey() {
  const db = await openKeyDb();
  const rec = await idbGet(db, 'keys', 'device_signing_v1');
  if (rec && rec.privateKey && rec.keyId && rec.publicKeySpkiB64) {
    return { privateKey: rec.privateKey, keyId: rec.keyId, publicKeySpkiB64: rec.publicKeySpkiB64 };
  }

  // Generate non-exportable key pair (private key stays inside WebCrypto)
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  // Public key should be exportable as SPKI; if it fails, we still sign but cannot provide a stable key_id.
  let publicKeySpkiB64 = '';
  let keyId = 'unknown';
  try {
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    publicKeySpkiB64 = arrayBufferToBase64(spki);
    keyId = await sha256HexBytes(spki);
  } catch (e) {
    // Fallback: try JWK (public only)
    try {
      const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
      const jwkBytes = new TextEncoder().encode(JSON.stringify(jwk));
      publicKeySpkiB64 = arrayBufferToBase64(jwkBytes.buffer);
      keyId = await sha256HexBytes(jwkBytes.buffer);
    } catch (_) {
      // keep unknown
    }
  }

  await idbPut(db, 'keys', {
    id: 'device_signing_v1',
    createdAt: Date.now(),
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    keyId,
    publicKeySpkiB64
  });

  return { privateKey: kp.privateKey, keyId, publicKeySpkiB64 };
}

async function resolveTargetTab(activeTab, targetUrl) {
  if (!targetUrl) {
    if (!activeTab || !activeTab.id) throw new Error('No active tab found.');
    return activeTab;
  }

  let u;
  try {
    u = new URL(targetUrl);
  } catch (_) {
    throw new Error('Invalid URL. Paste a full https:// link.');
  }

  const host = (u.hostname || '').toLowerCase();
  const allowed =
    host.includes('claude.ai') ||
    host.includes('chatgpt.com') ||
    host.includes('chat.openai.com') ||
    host.includes('gemini.google.com') ||
    host.includes('bard.google.com') ||
    host === 'g.co';
  if (!allowed) {
    throw new Error('Unsupported site. Use Claude.ai, ChatGPT, or Gemini.');
  }

  // Reuse active tab if it already matches exactly.
  if (activeTab && activeTab.url === targetUrl) {
    return activeTab;
  }

  const tab = await chrome.tabs.create({ url: targetUrl, active: false });
  await waitForTabComplete(tab.id);
  return { ...tab, __rl4_temp: true };
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 8000);

    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 900);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function waitForContentScript(tabId) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timeoutMs = 9000;

    const tick = () => {
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
        if (chrome.runtime.lastError) {
          if (Date.now() - start > timeoutMs) {
            reject(new Error('Content script not ready. Please refresh the page and try again.'));
            return;
          }
          setTimeout(tick, 250);
          return;
        }
        if (response && response.ok) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Content script not ready. Please refresh the page and try again.'));
          return;
        }
        setTimeout(tick, 250);
      });
    };

    tick();
  });
}

/**
 * Get messages from content script via message passing
 */
async function getMessagesFromContentScript(tabId, captureId) {
  const attemptSend = () =>
    new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { action: 'getMessages', deep: true, captureId }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(response);
      });
    });

  const startedAt = Date.now();
  const timeoutMs = 9000;
  // Retry because newly opened tabs sometimes haven't registered the content script yet.
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await attemptSend();

      // content.js returns: { ok: true, messages: [...] } (and may include session_id)
      if (response && response.ok) {
        return Array.isArray(response.messages) ? response.messages : [];
      }

      // Backward/alternative formats support
      if (response && response.success) {
        return Array.isArray(response.messages) ? response.messages : [];
      }

      const errObj = response && response.error ? response.error : null;
      const msg =
        (errObj && errObj.message) ||
        (typeof response?.error === 'string' ? response.error : null) ||
        'Failed to get messages';
      throw new Error(msg);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const isNotReady =
        /receiving end does not exist/i.test(msg) ||
        /could not establish connection/i.test(msg) ||
        /message port closed/i.test(msg);
      if (!isNotReady) {
        throw new Error('Could not communicate with content script. Please refresh the page.');
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  throw new Error('Could not communicate with content script. Please refresh the page.');
}

/**
 * Copy text to clipboard
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    
    try {
      document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch (fallbackError) {
      document.body.removeChild(textarea);
      throw new Error('Please allow clipboard access or copy manually');
    }
  }
}

/**
 * Update metadata display
 */
function updateMetadata(snapshot) {
  const metadataDiv = document.getElementById('metadata');
  const messageCountEl = document.getElementById('messageCount');
  const compressionRatioEl = document.getElementById('compressionRatio');
  const captureCompletenessEl = document.getElementById('captureCompleteness');
  const checksumEl = document.getElementById('checksum');
  const metaDetailsEl = document.getElementById('metaDetails');

  messageCountEl.textContent = snapshot.metadata.messages || snapshot.metadata.total_messages || 0;
  compressionRatioEl.textContent =
    snapshot.metadata.compression_digest || snapshot.metadata.compression || snapshot.metadata.compression_ratio || 'N/A';
  if (captureCompletenessEl) {
    const c = snapshot?.metadata?.capture_completeness ? String(snapshot.metadata.capture_completeness) : 'unknown';
    const r = snapshot?.metadata?.capture_completeness_reason ? String(snapshot.metadata.capture_completeness_reason) : '';
    captureCompletenessEl.textContent = r ? `${c} (${r})` : c;
  }
  checksumEl.textContent = snapshot.checksum ? snapshot.checksum.substring(0, 16) + '...' : '-';

  // Details (optional): keep useful capture proof without adding CTAs.
  if (metaDetailsEl) {
    const provider = String(snapshot?.metadata?.capture_provider || '').toLowerCase();
    const strategy = String(snapshot?.metadata?.capture_strategy || '').toLowerCase();
    const pages = snapshot?.metadata?.capture_pages_fetched;
    const reason = String(snapshot?.metadata?.capture_completeness_reason || '');
    const transcriptRef = String(snapshot?.metadata?.transcript_ref || '');
    const transcriptSha = String(snapshot?.metadata?.transcript_sha256 || snapshot?.conversation_fingerprint?.sha256 || '');
    const lines = [];
    if (provider) lines.push(`provider: ${provider}`);
    if (strategy) lines.push(`strategy: ${strategy}`);
    if (reason) lines.push(`capture_reason: ${reason}`);
    if (typeof pages === 'number') lines.push(`pages_fetched: ${pages}`);
    if (transcriptRef) lines.push(`transcript_ref: ${transcriptRef}`);
    if (transcriptSha) lines.push(`transcript_sha256: ${transcriptSha}`);
    metaDetailsEl.textContent = lines.join('\n');
  }

  metadataDiv.classList.remove('hidden');
  // If a previous "Reload" forced display:none, undo it.
  metadataDiv.style.display = '';
}

/**
 * Show status message
 */
function showStatus(type, message) {
  const statusDiv = document.getElementById('status');
  statusDiv.className = `status ${type}`;
  statusDiv.textContent = message;
  statusDiv.classList.remove('hidden');
}

function hideStatus() {
  const statusDiv = document.getElementById('status');
  if (!statusDiv) return;
  statusDiv.className = 'status hidden';
  statusDiv.textContent = '';
  statusDiv.classList.add('hidden');
}

async function detectHandoffProviderFromActiveTabOrSnapshot(snap) {
  try {
    const tab = await getTargetActiveTab();
    const url = typeof tab?.url === 'string' ? tab.url : '';
    const host = url ? new URL(url).hostname.toLowerCase() : '';
    if (host === 'copilot.microsoft.com') return 'copilot';
  } catch (_) {}
  try {
    const p = String(snap?.metadata?.capture_provider || '').toLowerCase();
    if (p === 'copilot') return 'copilot';
  } catch (_) {}
  return '';
}

/**
 * Show raw JSON in new window (for debugging)
 */
function showRawJSON(snapshot) {
  const jsonStr = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  // Open in new tab
  chrome.tabs.create({ url });
  
  // Cleanup after a delay
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

