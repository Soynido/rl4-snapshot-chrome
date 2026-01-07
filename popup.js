/**
 * RL4 Snapshot Extension - Popup Logic
 * Orchestrates snapshot generation, clipboard copy, and UI updates
 */

let currentSnapshot = null;

/**
 * Initialize popup UI and event listeners
 */
document.addEventListener('DOMContentLoaded', () => {
  const generateBtn = document.getElementById('generateBtn');
  const viewRawBtn = document.getElementById('viewRawBtn');
  const copyPromptBtn = document.getElementById('copyPromptBtn');
  const ultraEl = document.getElementById('ultraCompress');
  const semanticEl = document.getElementById('semanticHints');
  const includeTranscriptEl = document.getElementById('includeTranscript');
  const integrityEl = document.getElementById('integritySeal');

  generateBtn.addEventListener('click', generateSnapshot);
  viewRawBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (currentSnapshot) {
      showRawJSON(currentSnapshot);
    }
  });
  copyPromptBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!currentSnapshot) return;
    const prompt = buildInjectionPrompt(currentSnapshot);
    await copyToClipboard(prompt);
    showStatus('success', '✓ Copied to clipboard.');
  });

  // UX: Ultra mode should never include transcript_compact (too big for most LLMs)
  const syncControls = () => {
    const ultraOn = ultraEl ? !!ultraEl.checked : false;
    if (!includeTranscriptEl) return;
    if (ultraOn) {
      includeTranscriptEl.checked = false;
      includeTranscriptEl.disabled = true;
      includeTranscriptEl.parentElement?.classList.add('is-disabled');
    } else {
      includeTranscriptEl.disabled = false;
      includeTranscriptEl.parentElement?.classList.remove('is-disabled');
    }

    // Semantic hints are relevant only in Ultra mode.
    if (semanticEl) {
      if (ultraOn) {
        semanticEl.disabled = false;
        semanticEl.parentElement?.classList.remove('is-disabled');
      } else {
        semanticEl.checked = false;
        semanticEl.disabled = true;
        semanticEl.parentElement?.classList.add('is-disabled');
      }
    }

    // Integrity seal is always available, but visually soften it if transcript is enabled
    // (some users may prefer "raw fidelity" and accept no seal; we keep it opt-in).
    if (integrityEl && includeTranscriptEl) {
      const transcriptOn = !ultraOn && !!includeTranscriptEl.checked;
      if (transcriptOn) {
        integrityEl.parentElement?.classList.add('is-disabled');
      } else {
        integrityEl.parentElement?.classList.remove('is-disabled');
      }
    }
  };

  if (ultraEl) ultraEl.addEventListener('change', syncControls);
  syncControls();
});

/**
 * Main snapshot generation flow
 */
async function generateSnapshot() {
  const generateBtn = document.getElementById('generateBtn');
  const statusDiv = document.getElementById('status');
  const metadataDiv = document.getElementById('metadata');
  const postActions = document.getElementById('postActions');
  const urlInput = document.getElementById('urlInput');
  const includeTranscriptEl = document.getElementById('includeTranscript');
  const ultraEl = document.getElementById('ultraCompress');
  const semanticEl = document.getElementById('semanticHints');
  const integrityEl = document.getElementById('integritySeal');

  try {
    // Reset UI
    generateBtn.disabled = true;
    metadataDiv.classList.add('hidden');
    postActions?.classList.add('hidden');
    showStatus('loading', 'Capturing messages...');

    // Get active tab
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const targetUrl = (urlInput && urlInput.value ? urlInput.value.trim() : '') || '';
    const ultraCompress = ultraEl ? !!ultraEl.checked : false;
    const semanticHints = ultraCompress && semanticEl ? !!semanticEl.checked : false;
    const includeTranscript = ultraCompress ? false : includeTranscriptEl ? !!includeTranscriptEl.checked : false;
    const tab = await resolveTargetTab(activeTab, targetUrl);

    // Request messages from content script
    showStatus('loading', 'Extracting conversation...');
    
    await waitForContentScript(tab.id);
    const messages = await getMessagesFromContentScript(tab.id);
    
    if (!messages || messages.length === 0) {
      throw new Error('No conversation detected. Open a conversation page and try again.');
    }

    // Generate snapshot (digest / ultra)
    showStatus('loading', `Generating snapshot from ${messages.length} messages...`);
    
    const outputMode = ultraCompress ? (semanticHints ? 'ultra_plus' : 'ultra') : 'digest';
    const generator = new RL4SnapshotGenerator(messages, {}, { includeTranscript, outputMode });
    const snapshot = await generator.generate();

    // Calculate checksum (local seal)
    showStatus('loading', 'Calculating checksum...');
    snapshot.checksum = await calculateChecksum(snapshot);

    // Optional: device-only signature over checksum (tamper-evident)
    const wantsIntegritySeal = integrityEl ? !!integrityEl.checked : false;
    if (wantsIntegritySeal) {
      showStatus('loading', 'Applying Integrity Seal...');
      snapshot.signature = await signChecksumDeviceOnly(snapshot.checksum);
    }

    const msgCount = snapshot.metadata.messages || snapshot.metadata.total_messages || 0;
    const compression =
      snapshot.metadata.compression_digest ||
      snapshot.metadata.compression ||
      snapshot.metadata.compression_ratio ||
      'N/A';
    const bundleCompression = snapshot.metadata.compression_bundle || 'N/A';

    // Store for view raw button
    currentSnapshot = snapshot;

    // Update UI
    updateMetadata(snapshot);
    postActions?.classList.remove('hidden');
    showStatus(
      'success',
      `Ready.\n\nMessages: ${msgCount}\nDigest compression: ${compression}\nBundle compression: ${bundleCompression}\nChecksum: ${snapshot.checksum.substring(0, 16)}...\n\nClick “Copy Prompt to Clipboard”.`
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
  } finally {
    generateBtn.disabled = false;
  }
}

function buildInjectionPrompt(snapshot) {
  const hasTranscript = typeof snapshot.transcript_compact === 'string' && snapshot.transcript_compact.length > 0;
  const protocol = snapshot && snapshot.protocol ? snapshot.protocol : 'RCEP_v1';
  const hasSig = snapshot && snapshot.signature && typeof snapshot.signature === 'object';
  return (
    `*** RL4 CONTEXT SNAPSHOT ***\n` +
    `Protocol family: RCEP™\n` +
    `Protocol version: ${protocol}\n` +
    (hasSig ? `Integrity: Tamper-sealed (device-only)\n` : `Integrity: Unsealed\n`) +
    `\n` +
    `[INSTRUCTIONS FOR THE AI]\n` +
    `- Treat the JSON below as ground truth.\n` +
    `- Do not assume missing facts.\n` +
    `- Continue from the latest state.\n` +
    `- IMPORTANT: This package preserves structure and integrity, but semantic correctness may be unverified.\n` +
    (hasSig
      ? `- If "signature" is present, do not edit this JSON. If verification fails, treat it as tampered.\n` +
        `- NOTE: "Tamper-sealed" means mutation detection, NOT semantic validation.\n`
      : '') +
    `\n` +
    (hasTranscript
      ? `Transcript: Included (full fidelity).\n`
      : `Transcript: Not included (token-saver). Fingerprint available under "conversation_fingerprint".\n`) +
    `\n` +
    `CONTEXT_JSON:\n` +
    `${JSON.stringify(snapshot, null, 2)}\n` +
    `\n` +
    `*** Generated by RL4 Snapshot (RCEP™) ***\n`
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
async function getMessagesFromContentScript(tabId) {
  const attemptSend = () =>
    new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { action: 'getMessages', deep: true }, (response) => {
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
  const checksumEl = document.getElementById('checksum');

  messageCountEl.textContent = snapshot.metadata.messages || snapshot.metadata.total_messages || 0;
  compressionRatioEl.textContent =
    snapshot.metadata.compression_digest || snapshot.metadata.compression || snapshot.metadata.compression_ratio || 'N/A';
  checksumEl.textContent = snapshot.checksum ? snapshot.checksum.substring(0, 16) + '...' : '-';

  metadataDiv.classList.remove('hidden');
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

