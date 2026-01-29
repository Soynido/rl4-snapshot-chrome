/* global calculateChecksum, extractTopics, extractTopicsWithMeta, extractDecisions, extractInsights, extractConstraints, canonicalize, splitIntoCognitiveDays, buildCausalChains, buildProgressiveSummary */

/**
 * Transform raw messages into a structured RL4 snapshot.
 */
class RL4SnapshotGenerator {
  /**
   * @param {Array<{id:string, role:'user'|'assistant', content:string, timestamp?:string, session_id?:string}>} messages
   * @param {Object} budget
   * @param {Object} options
   */
  constructor(messages, budget = {}, options = {}) {
    this.messages = Array.isArray(messages) ? messages : [];
    const now = Date.now();
    this.budget = {
      // XXL-safe: 2s is too tight for 1500+ msgs once we add hashing / extraction.
      // Keep it bounded but realistic to avoid accidental "partial" outputs on large captures.
      deadline: budget.deadline || now + 8000, // 8s max
      maxTopics: budget.maxTopics || 7,
      // V2: Increased limits for better extraction
      maxDecisions: budget.maxDecisions || 20,
      maxInsights: budget.maxInsights || 30,
      maxConstraints: budget.maxConstraints || 15
    };
    this.options = {
      includeTranscript: options.includeTranscript !== undefined ? !!options.includeTranscript : true,
      // digest: current default, ultra: aggressive size cut
      outputMode: options.outputMode === 'ultra' || options.outputMode === 'ultra_plus' ? options.outputMode : 'digest'
    };
  }

  /**
   * Check if deadline exceeded
   * @returns {boolean}
   */
  _checkDeadline() {
    return Date.now() > this.budget.deadline;
  }

  /**
   * Pick a stable session_id from captured messages.
   * Prefers a non-unknown conv id when present.
   * @param {string} nowIso
   * @returns {string}
   */
  _pickSessionId(nowIso) {
    const nonUnknown = this.messages.find((m) => m.session_id && !/^conv-unknown-/.test(m.session_id))?.session_id;
    if (nonUnknown) return nonUnknown;

    const any = this.messages.find((m) => m.session_id)?.session_id;
    if (any) {
      const match = any.match(/^conv-(.+?)-/);
      if (match && match[1] && match[1] !== 'unknown') return `conv-${match[1]}-${nowIso}`;
    }

    return `conv-hash-${Date.now().toString(16)}-${nowIso}`;
  }

  /**
   * Main entry point.
   * @returns {Promise<any>}
   */
  async generate() {
    const nowIso = new Date().toISOString();
    const sessionId = this._pickSessionId(nowIso);

    if (this._checkDeadline()) {
      return this.generatePartialSnapshot('deadline_exceeded');
    }

    // Extract topics with metadata (proof-grade)
    const topicsResult = this.extractTopicsWithMeta();
    const topics = topicsResult.topics.slice(0, this.budget.maxTopics);
    const topicsMeta = topicsResult.meta;

    if (this._checkDeadline()) {
      return this.generatePartialSnapshot('deadline_exceeded', { topics, topics_meta: topicsMeta });
    }

    const decisions = this.extractDecisions().slice(0, this.budget.maxDecisions);

    if (this._checkDeadline()) {
      return this.generatePartialSnapshot('deadline_exceeded', { topics, decisions });
    }

    const insights = this.extractInsights().slice(0, this.budget.maxInsights);
    
    // V2: Extract constraints (DON'T/DO/technical limitations)
    const constraints = this.extractConstraints();
    
    const contextSummary = this.generateSummary({ topics, decisions });

    // Deduplicate messages (remove exact duplicates and system messages)
    const deduplicatedMessages = this._deduplicateMessages(this.messages, topics, decisions);
    // Normalize messages so all carry the chosen sessionId (avoid mixed/unknown ids)
    const normalizedMessages = deduplicatedMessages.map((m) => ({
      ...m,
      session_id: sessionId
    }));

    const originalSize = this.messages.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);

    // RL4 digest mode:
    // - No full transcript in the clipboard JSON by default (to avoid token explosion)
    // - Keep verifiability: include a fingerprint of the FULL transcript
    // IMPORTANT (XXL): avoid building one giant transcript string + one giant Uint8Array in the renderer.
    // We compute a stable "merkle-style" SHA-256 fingerprint:
    //   leaf_i = SHA256( role + "\n" + content )
    //   root   = SHA256( leaf_0_bytes || leaf_1_bytes || ... || leaf_n_bytes )
    const { transcriptSha256, transcriptFormat, transcriptCompact, fingerprintMethod, fingerprintBatching } = await this._fingerprintTranscript(normalizedMessages);

    // Digest without transcript (pure “analysis” compression target)
    const digestWithoutTranscript = {
      _branding: {
        generator: 'RL4 Snapshot',
        protocol_family: 'RL4',
        notice: 'RL4 Snapshot — Cross-LLM context transfer.',
        mode: 'digest'
      },
      protocol: 'RL4',
      version: '1.0',
      producer: {
        product: 'RL4 Snapshot',
        protocol_family: 'RL4',
        generator: 'rl4-snapshot-extension',
        mode: 'digest'
      },
      session_id: sessionId,
      timestamp: nowIso,
      context_state: {
        core_subject: 'RL4 Snapshot (Browser Chat)',
        current_goal: 'Capture → Compress → Seal',
        status: 'Digest generated'
      },
      topics,
      decisions,
      insights,
      constraints,
      context_summary: contextSummary,
      conversation_fingerprint: {
        algorithm: 'sha256',
        transcript_format: transcriptFormat,
        sha256: transcriptSha256
      },
      metadata: {
        messages: normalizedMessages.length,
        messages_original: this.messages.length,
        original_size_chars: originalSize,
        digest_size_chars: 0,
        compression_digest: '0x',
        generated_at: nowIso,
        fingerprint_method: fingerprintMethod,
        fingerprint_batching: !!fingerprintBatching
      },
      checksum: ''
    };

    // Final digest copied by the CTA (still small)
    const digest = {
      _branding: {
        generator: 'RL4 Snapshot',
        protocol_family: 'RL4',
        notice: 'RL4 Snapshot — Cross-LLM context transfer.',
        mode: 'digest'
      },
      protocol: 'RL4',
      version: '1.0',
      producer: {
        product: 'RL4 Snapshot',
        protocol_family: 'RL4',
        generator: 'rl4-snapshot-extension',
        mode: 'digest'
      },
      session_id: sessionId,
      timestamp: nowIso,
      context_state: {
        core_subject: 'RL4 Snapshot (Browser Chat)',
        current_goal: 'Capture → Compress → Seal',
        status: 'Digest generated'
      },
      topics,
      // topics_meta: proof-grade metadata about extraction quality (facts, not views)
      topics_meta: topicsMeta,
      decisions,
      // decision_analysis: structural stats (no text matching, purely mechanical)
      decision_analysis: this._buildDecisionAnalysis(decisions),
      insights,
      // Keep a short summary only (LLMs can reconstruct reasoning from structured fields)
      context_summary: contextSummary,
      // Keep a minimal "timeline" (heuristic) without inventing content
      timeline_summary: this._timelineSummary(normalizedMessages),
      // Activity cycles: purely mechanical temporal segmentation (no semantic labels)
      activity_cycles_mechanical: this._buildActivityCyclesMechanical(normalizedMessages, { maxCycles: 6 }),
      // timeline_macro_view_v1: DERIVED view with keywords (not proof-grade, marked as derived)
      timeline_macro_view_v1: {
        derived: true,
        method_version: 'keyword_frequency_v1',
        derived_from: 'messages',
        phases: this._timelineMacro(normalizedMessages, { maxPhases: 6 })
      },
      conversation_fingerprint: {
        algorithm: 'sha256',
        transcript_format: transcriptFormat,
        sha256: transcriptSha256
      },
      metadata: {
        messages: normalizedMessages.length,
        messages_original: this.messages.length,
        original_size_chars: originalSize,
        digest_size_chars: 0,
        bundle_size_chars: 0,
        compression_digest: '0x',
        compression_bundle: '0x',
        generated_at: nowIso,
        fingerprint_method: fingerprintMethod,
        fingerprint_batching: !!fingerprintBatching
      },
      checksum: '' // computed later
    };

    // Workspace proof injection (backend-provided):
    // If a synthetic message contains `RL4_EVIDENCE_JSON`, we parse it and embed it into the snapshot metadata.
    // This keeps the UI unchanged while making the final prompt proof-grade (even without transcript).
    // NOTE: evidence blobs are very "code-like" and may be dropped by _deduplicateMessages().
    // We therefore parse from the original captured messages, not the deduplicated list.
    const evidence = this._extractEvidenceFromMessages(this.messages);
    if (evidence) {
      digest.metadata.evidence_checksum = evidence.checksum || '';
      digest.metadata.evidence_pack = evidence.pack || null;
      digest.metadata.evidence_source = 'workspace_activity';
      digest.metadata.evidence_status = evidence.status || 'collected';
      if (evidence.reason) digest.metadata.evidence_status_reason = evidence.reason;
      digestWithoutTranscript.metadata.evidence_checksum = evidence.checksum || '';
      digestWithoutTranscript.metadata.evidence_pack = evidence.pack || null;
      digestWithoutTranscript.metadata.evidence_source = 'workspace_activity';
      digestWithoutTranscript.metadata.evidence_status = evidence.status || 'collected';
      if (evidence.reason) digestWithoutTranscript.metadata.evidence_status_reason = evidence.reason;
    } else {
      // No evidence found: explicit status
      digest.metadata.evidence_status = 'skipped';
      digest.metadata.evidence_status_reason = 'no_evidence_message_found';
      digestWithoutTranscript.metadata.evidence_status = 'skipped';
      digestWithoutTranscript.metadata.evidence_status_reason = 'no_evidence_message_found';
    }

    // scan_id: stable anchor based on evidenceChecksum (proof-grade correlation key)
    // Fallback to sha256(sessionId + timestamp) if no evidence
    const scanIdBase = evidence?.checksum || `${sessionId}:${nowIso}`;
    const scanId = evidence?.checksum || await this._sha256Hex(scanIdBase);
    digest.scan_id = scanId;
    digestWithoutTranscript.scan_id = scanId;

    // Commitments: mechanical evidence of activity (no NLP, no inference)
    const commitments = this._buildCommitments({
      evidencePack: digest.metadata.evidence_pack,
      evidenceStatus: digest.metadata.evidence_status,
      messages: this.messages
    });
    digest.commitments = commitments;
    digestWithoutTranscript.commitments = commitments;

    // Optional: include full-fidelity transcript (no loss of context, but more tokens).
    // Track if transcript was added for re-seal requirement
    let transcriptAdded = false;
    if (this.options.includeTranscript && this.options.outputMode !== 'ultra' && this.options.outputMode !== 'ultra_plus') {
      // transcriptCompact is only built when includeTranscript=true (see _fingerprintTranscript)
      digest.transcript_compact = transcriptCompact;
      digest.transcript_format = 'ROLE:\\nCONTENT (messages separated by \\n\\n<|RL4_MSG|>\\n\\n)';
      transcriptAdded = true;
    }

    // capture_bounds: centralized proof-grade metadata (generated by RL4, not LLM)
    const captureBounds = this._buildCaptureBounds({
      messages: normalizedMessages,
      evidence,
      transcriptSha256,
      transcriptFormat,
      transcriptIncluded: transcriptAdded,
      captureSource: 'cursor_chat_v1'
    });
    digest.capture_bounds = captureBounds;
    digestWithoutTranscript.capture_bounds = captureBounds;

    // ============================================================================
    // TIME MACHINE V1.2 - Activity data from evidence pack
    // ============================================================================
    
    // Extract time machine data from evidence pack if available
    const timeMachineData = this._extractTimeMachineData(evidence);
    if (timeMachineData) {
      digest.activity_summary = timeMachineData.activity_summary;
      digest.bursts = timeMachineData.bursts;
      digest.causal_links = timeMachineData.causal_links;
      digest.trace_pointers = timeMachineData.trace_pointers;
      digest.system_health = timeMachineData.system_health;
      
      digestWithoutTranscript.activity_summary = timeMachineData.activity_summary;
      digestWithoutTranscript.bursts = timeMachineData.bursts;
      digestWithoutTranscript.causal_links = timeMachineData.causal_links;
      digestWithoutTranscript.trace_pointers = timeMachineData.trace_pointers;
      digestWithoutTranscript.system_health = timeMachineData.system_health;
    }

    // ============================================================================
    // COGNITIVE PROCESSING V2.0 - Semantic Enhancement
    // ============================================================================
    
    // Build cognitive days (thematic pivot detection via Jaccard similarity)
    const cognitiveDays = this._buildCognitiveDays(normalizedMessages, {
      similarityThreshold: 0.25,
      windowSize: 5,
      minDaySize: 3,
      maxDays: 10
    });
    if (cognitiveDays.length > 0) {
      digest.cognitive_days = cognitiveDays;
      digestWithoutTranscript.cognitive_days = cognitiveDays;
    }

    // Build causal chains (trigger → decision → implementation → outcome)
    const causalChainsV2 = this._buildCausalChainsFromData(
      decisions, 
      evidence?.pack || {}, 
      insights,
      { maxChains: 10, minImpactScore: 0.3 }
    );
    if (causalChainsV2.length > 0) {
      digest.causal_chains_v2 = causalChainsV2;
      digestWithoutTranscript.causal_chains_v2 = causalChainsV2;
    }

    // Build progressive summary (L1/L2/L3 levels)
    const progressiveSummary = this._buildProgressiveSummaryFromData({
      contextSummary,
      topics,
      decisions,
      insights,
      contextState: digest.context_state,
      metadata: digest.metadata,
      cognitiveDays,
      timelineMacro: digest.timeline_macro_view_v1?.phases || []
    });
    digest.progressive_summary = progressiveSummary;
    digestWithoutTranscript.progressive_summary = progressiveSummary;

    // Compression metric: original conversation chars / digest-without-transcript chars (10–20x goal)
    // Compression metric: avoid deep canonicalization here (it can double memory usage on XXL objects).
    // This metric is informational only; integrity uses calculateChecksum().
    const digestJson = JSON.stringify(digest);

    // correctness fix — do not optimize away
    // compression_digest must use the ACTUAL digest JSON length (with timeline fields), not digestWithoutTranscript
    digest.metadata.digest_size_chars = digestJson.length;
    digest.metadata.compression_digest = this.calculateCompressionRatio(originalSize, digestJson.length);
    digest.metadata.bundle_size_chars = digestJson.length;
    digest.metadata.compression_bundle = this.calculateCompressionRatio(originalSize, digestJson.length);
    // Mark if transcript was included (for re-seal verification)
    digest.metadata.transcript_included = transcriptAdded;

    // If ultra mode requested, emit an even smaller payload (lossy on non-critical fields).
    if (this.options.outputMode === 'ultra' || this.options.outputMode === 'ultra_plus') {
      // Pre-compute stable hashes for decision choices (without storing full text in Ultra/Ultra+).
      const decision_choice_sha256 = {};
      try {
        for (const d of Array.isArray(digest.decisions) ? digest.decisions : []) {
          const id = String(d?.id || '');
          if (!id) continue;
          const full = String(d?.chosen_option || '');
          if (!full) continue;
          decision_choice_sha256[id] = await this._sha256Hex(full);
        }
      } catch (_) {
        // If hashing fails, proceed without hashes (best effort).
      }

      const ultra = this._buildUltraSnapshot({
        digest,
        originalSize,
        transcriptSha256,
        fingerprintMethod,
        fingerprintBatching,
        messages: normalizedMessages,
        semanticHints: this.options.outputMode === 'ultra_plus',
        decision_choice_sha256
      });
      const canonicalUltra = typeof canonicalize === 'function' ? canonicalize(ultra) : ultra;
      ultra.checksum = await calculateChecksum(canonicalUltra);
      return ultra;
    }

    // Re-seal: checksum is computed AFTER all fields (including transcript_compact) are set
    // This guarantees integrity of the complete bundle
    digest.checksum = await calculateChecksum(digest);
    return digest;
  }

  /**
   * Extract and parse backend-provided evidence from messages.
   * Format:
   *   RL4_EVIDENCE_JSON
   *   evidence_checksum: <hex>
   *   ...
   *   { ...json... }
   *
   * Returns null if not present or invalid.
   */
  _extractEvidenceFromMessages(messages) {
    try {
      const msgs = Array.isArray(messages) ? messages : [];
      // Prefer the most recent evidence block with a checksum; ignore user-injected blocks.
      const reversed = [...msgs].reverse();
      let sawMarker = false;
      let rejectedReason = '';
      for (const m of reversed) {
        if (!m || typeof m.content !== 'string' || !m.content.includes('RL4_EVIDENCE_JSON')) continue;
        sawMarker = true;
        const text = String(m.content || '');
        const checksumMatch = text.match(/evidence_checksum:\s*([a-f0-9]{0,64})/i);
        const checksum = checksumMatch && checksumMatch[1] && checksumMatch[1].length >= 16 ? checksumMatch[1] : '';
        const statusMatch = text.match(/evidence_status:\s*(collected|skipped|error)/i);
        const status = statusMatch ? statusMatch[1].toLowerCase() : 'collected';
        const reasonMatch = text.match(/evidence_status_reason:\s*([^\n]+)/i);
        const reason = reasonMatch ? reasonMatch[1].trim() : undefined;
        const idx = text.indexOf('{');
        let pack = null;
        if (idx >= 0) {
          const jsonText = text.slice(idx).trim();
          try { pack = JSON.parse(jsonText); } catch { pack = null; }
        }

        const hasValidChecksum = checksum.length >= 16;
        const hasBackendId = typeof m.generationUUID === 'string' && m.generationUUID.startsWith('rl4-evidence-');
        const isValid = hasValidChecksum && hasBackendId;

        if (!isValid) {
          if (!hasValidChecksum) rejectedReason = 'rejected:missing_checksum';
          else if (!hasBackendId) rejectedReason = 'rejected:user_injected';
          else rejectedReason = 'rejected:legacy_block';
          continue;
        }

        return { checksum, pack, status, reason };
      }
      if (sawMarker) {
        return { checksum: '', pack: null, status: 'skipped', reason: rejectedReason || 'rejected:user_injected' };
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  _buildCommitments(params) {
    const evidencePack = params?.evidencePack || null;
    const evidenceStatus = String(params?.evidenceStatus || 'skipped');
    const messages = Array.isArray(params?.messages) ? params.messages : [];

    const fileEvents = Array.isArray(evidencePack?.recent_file_events) ? evidencePack.recent_file_events.length : 0;
    const ideActivity = evidencePack?.ide_activity ? 1 : 0;
    const chatMessages = messages.length;

    const reasons = [];
    if (!fileEvents) reasons.push('no_file_events_in_range');
    if (!ideActivity) reasons.push('no_ide_activity');
    if (!chatMessages) reasons.push('no_chat_messages');
    if (evidenceStatus === 'skipped') reasons.push('evidence_skipped');
    if (evidenceStatus === 'error') reasons.push('evidence_error');
    if (evidencePack?.partial) {
      const r = evidencePack.partial_reason || 'unknown';
      reasons.push(`evidence_partial:${r}`);
    }

    let status = 'OK';
    if (chatMessages === 0 && fileEvents === 0 && ideActivity === 0) {
      status = 'EMPTY';
    } else if (reasons.some((r) => r.startsWith('evidence_partial') || r === 'evidence_skipped' || r === 'evidence_error')) {
      status = 'PARTIAL';
    }

    return {
      file_events: {
        count: fileEvents
      },
      ide_activity: {
        present: !!ideActivity
      },
      chat_capture: {
        messages: chatMessages
      },
      status,
      reason: reasons
    };
  }

  /**
   * Compute transcript fingerprint without constructing a giant transcript string on XXL chats.
   * Returns:
   * - transcriptSha256: stable fingerprint
   * - transcriptFormat: description of how the fingerprint was derived (for verifiers)
   * - transcriptCompact: only when includeTranscript=true
   *
   * @param {Array<{role:'user'|'assistant', content:string}>} messages
   * @returns {Promise<{transcriptSha256:string, transcriptFormat:string, transcriptCompact:string, fingerprintMethod:string, fingerprintBatching:boolean}>}
   */
  async _fingerprintTranscript(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const n = list.length;

    // If user explicitly asked for transcript_compact, build it (small chats only).
    // NOTE: runSnapshotJob auto-disables includeTranscript on big chats.
    let transcriptCompact = '';
    if (this.options.includeTranscript && this.options.outputMode !== 'ultra' && this.options.outputMode !== 'ultra_plus') {
      transcriptCompact = this._encodeMessagesCompact(list);
      const transcriptSha256 = await this._sha256Hex(transcriptCompact);
      return {
        transcriptSha256,
        transcriptFormat: 'ROLE:\\nCONTENT (messages separated by \\n\\n<|RL4_MSG|>\\n\\n)',
        transcriptCompact,
        fingerprintMethod: 'single_hash',
        fingerprintBatching: false
      };
    }

    // XXL-safe: chunked merkle-style fingerprint to avoid N SHA-256 digests (one per message),
    // which can exceed the generator deadline on very long chats.
    // chunk_i = sha256( encodeMessagesCompact(messages[i..i+K]) )
    // root    = sha256( concat(chunk_i_bytes) )
    const encoder = new TextEncoder();
    const chunkSize = n > 2000 ? 120 : n > 800 ? 80 : 60;
    const chunkHashes = [];
    const shouldBatch = n > 3000;
    const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

    const sha256Bytes = async (bytes) => {
      const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
      return new Uint8Array(hashBuffer); // 32 bytes
    };

    if (shouldBatch && typeof ReadableStream !== 'undefined') {
      // Stream chunks to avoid large buffers and keep UI responsive
      let cursor = 0;
      const stream = new ReadableStream({
        pull: (controller) => {
          if (cursor >= n) {
            controller.close();
            return;
          }
          const end = Math.min(n, cursor + chunkSize);
          const slice = list.slice(cursor, end);
          const chunkTranscript = this._encodeMessagesCompact(slice);
          controller.enqueue(encoder.encode(chunkTranscript));
          cursor = end;
        }
      });

      const reader = stream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunkHashes.push(await sha256Bytes(value));
        if (chunkHashes.length % 25 === 0) {
          await yieldToUI();
        }
      }
    } else {
    for (let start = 0; start < n; start += chunkSize) {
      const end = Math.min(n, start + chunkSize);
      const slice = list.slice(start, end);
      const chunkTranscript = this._encodeMessagesCompact(slice);
        const bytes = encoder.encode(String(chunkTranscript || ''));
        chunkHashes.push(await sha256Bytes(bytes));
      }
    }

    const rootBytes = new Uint8Array(chunkHashes.length * 32);
    for (let i = 0; i < chunkHashes.length; i++) {
      rootBytes.set(chunkHashes[i], i * 32);
    }

    const rootBuf = await crypto.subtle.digest('SHA-256', rootBytes);
    const rootArr = Array.from(new Uint8Array(rootBuf));
    const transcriptSha256 = rootArr.map((b) => b.toString(16).padStart(2, '0')).join('');
    return {
      transcriptSha256,
      transcriptFormat: `CHUNK_MERKLE_SHA256: chunk=sha256(transcript_compact_slice) root=sha256(concat(chunk_hash_bytes)) chunk_size=${chunkSize}`,
      transcriptCompact: '',
      fingerprintMethod: shouldBatch ? 'merkle_chunked_stream' : 'merkle_chunked',
      fingerprintBatching: shouldBatch
    };
  }

  /**
   * Build an ultra-compressed, LLM-safe context package.
   * Goals:
   * - Remove transcript/messages arrays entirely
   * - Drop message_refs (space waste)
   * - Keep only high-weight topics and high-confidence/critical decisions
   * - Replace timeline_summary with 5–7 macro phases (non-semantic, no hallucination)
   *
   * @param {{digest:any, originalSize:number, transcriptSha256:string, messages:Array<any>}} input
   * @returns {any}
   */
  _buildUltraSnapshot(input) {
    const digest = input && input.digest ? input.digest : {};
    const msgs = Array.isArray(input?.messages) ? input.messages : [];
    const originalSize = typeof input?.originalSize === 'number' ? input.originalSize : 0;
    const nowIso = digest.timestamp || new Date().toISOString();
    const semanticHints = !!input?.semanticHints;
    const decisionChoiceSha = input?.decision_choice_sha256 && typeof input.decision_choice_sha256 === 'object'
      ? input.decision_choice_sha256
      : {};

    // 1) Prune topics: keep only strong topics and drop message_refs arrays.
    const topics = Array.isArray(digest.topics) ? digest.topics : [];
    const prunedTopics = topics
      .filter((t) => (t && typeof t.weight === 'number' ? t.weight : 0) > 700)
      .map((t) => ({
        label: t.label,
        weight: t.weight,
        summary: t.summary
      }));

    // 2) Prune decisions: keep only high confidence OR critical intents (structural, not semantic).
    const criticalIntents = new Set(['decide', 'recommend']);
    const decisions = Array.isArray(digest.decisions) ? digest.decisions : [];
    const prunedDecisions = decisions
      .filter((d) => {
        const c = typeof d?.confidence_llm === 'number' ? d.confidence_llm : 0;
        const intent = String(d?.intent || '');
        return c > 80 || criticalIntents.has(intent);
      })
      .map((d) => ({
        id: d.id,
        intent: d.intent,
        // Keep enough to be actionable (still bounded), plus a hash of the full choice for integrity.
        choice: this._excerpt(d.chosen_option || '', 240),
        choice_sha256: decisionChoiceSha[String(d.id || '')] || '',
        rationale: this._excerpt(d.intent_text || '', 140)
      }));

    // 3) Macro timeline: 5–7 entries max, grouped by message ranges only (no semantic labeling).
    const timeline_macro = this._timelineMacro(msgs, { maxPhases: 6 });

    const ultraProtocol = semanticHints ? 'RL4_UltraPlus' : 'RL4_Ultra';
    const ultra = {
      _branding: {
        generator: 'RL4 Snapshot',
        protocol_family: 'RL4',
        notice: 'RL4 Snapshot — Cross-LLM context transfer.',
        mode: semanticHints ? 'ultra_plus' : 'ultra'
      },
      protocol: ultraProtocol,
      producer: {
        product: 'RL4 Snapshot',
        protocol_family: 'RL4',
        generator: 'rl4-snapshot-extension',
        mode: semanticHints ? 'ultra_plus' : 'ultra'
      },
      session_id: digest.session_id || `conv-${Date.now().toString(16)}`,
      timestamp: nowIso,
      context_state: {
        ...(digest.context_state || {}),
        status: semanticHints ? 'Ultra+ generated' : 'Ultra generated'
      },
      topics: prunedTopics,
      decisions: prunedDecisions,
      timeline_macro,
      ...(semanticHints
        ? this._ultraSemanticHints({
            digest,
            prunedTopics,
            prunedDecisions,
            rawDecisions: Array.isArray(digest.decisions) ? digest.decisions : [],
            timeline_macro,
            messages: msgs
          })
        : {}),
      conversation_fingerprint: {
        algorithm: 'sha256',
        sha256: String(input?.transcriptSha256 || '')
      },
      metadata: {
        total_messages: msgs.length,
        generated_at: nowIso,
        compression_ratio: '0x',
        fingerprint_method: String(input?.fingerprintMethod || ''),
        fingerprint_batching: !!input?.fingerprintBatching,
        // Keep proof reference only (do not embed full evidence pack in Ultra).
        evidence_checksum: digest?.metadata?.evidence_checksum || ''
      },
      checksum: ''
    };

    const ultraJson = JSON.stringify(typeof canonicalize === 'function' ? canonicalize(ultra) : ultra);
    ultra.metadata.compression_ratio = this.calculateCompressionRatio(originalSize, ultraJson.length);
    return ultra;
  }

  /**
   * Minimal semantic hints for Ultra mode (no transcript).
   * Must be non-inventive: derived only from existing fields (topics/decisions/timeline/context_state).
   * @param {{digest:any, prunedTopics:any[], prunedDecisions:any[], timeline_macro:any[]}} input
   * @returns {{context_summary_ultra:string, validation_checklist:string[], unknowns:Array<{term:string, reason:string}>}}
   */
  _ultraSemanticHints(input) {
    const digest = input && input.digest ? input.digest : {};
    const topics = Array.isArray(input?.prunedTopics) ? input.prunedTopics : [];
    const decisions = Array.isArray(input?.prunedDecisions) ? input.prunedDecisions : [];
    const rawDecisions = Array.isArray(input?.rawDecisions) ? input.rawDecisions : [];
    const timeline = Array.isArray(input?.timeline_macro) ? input.timeline_macro : [];
    const messages = Array.isArray(input?.messages) ? input.messages : [];

    const core = String(digest?.context_state?.core_subject || '').trim();
    const goal = String(digest?.context_state?.current_goal || '').trim();
    const topicLabels = topics.map((t) => t.label).filter(Boolean).slice(0, 6);
    const decisionIntents = decisions.map((d) => d.intent).filter(Boolean).slice(0, 4);

    const summaryParts = [];
    if (core) summaryParts.push(`Subject: ${core}.`);
    if (goal) summaryParts.push(`Goal: ${goal}.`);
    if (topicLabels.length) summaryParts.push(`Topics: ${topicLabels.join(', ')}.`);
    if (decisionIntents.length) summaryParts.push(`Decisions: ${decisionIntents.join(', ')}.`);
    if (timeline.length) summaryParts.push(`Timeline: ${timeline.length} phases.`);
    let context_summary_ultra = summaryParts.join(' ');
    if (context_summary_ultra.length > 280) context_summary_ultra = context_summary_ultra.slice(0, 277) + '...';

    // Extract checklist items from decision "choice" text (often contains explicit "If ..." / "Si ..." clauses).
    const checklist = [];
    const src = decisions.map((d) => String(d.choice || '')).join(' ');
    const candidates = src
      .split(/[\n\r]+|(?<=\.)\s+|(?<=\!)\s+|(?<=\?)\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const c of candidates) {
      const isIf = /^if\s+/i.test(c);
      const isSi = /^si\s+/i.test(c);
      if (!isIf && !isSi) continue;
      const item = c.replace(/\s+/g, ' ').trim();
      if (item.length < 8) continue;
      checklist.push(item.length > 160 ? item.slice(0, 157) + '...' : item);
      if (checklist.length >= 6) break;
    }

    // Identify ambiguous tokens (do NOT define them, just flag them).
    const suspicious = new Set();
    const addIfSuspicious = (w) => {
      const t = String(w || '').trim();
      if (!t) return;
      if (/\d/.test(t) || /^vm\d+/i.test(t) || /[_-]/.test(t)) suspicious.add(t);
      if (/^ncontent$/i.test(t)) suspicious.add(t);
    };
    for (const t of topicLabels) addIfSuspicious(t);
    for (const ph of timeline) {
      const s = String(ph?.summary || '');
      const m = s.match(/Keywords:\s*([^•]+)/i);
      if (m && m[1]) {
        for (const raw of m[1].split(',')) addIfSuspicious(raw.trim());
      }
    }

    const unknowns = [...suspicious]
      .slice(0, 6)
      .map((term) => ({ term, reason: 'Observed token; meaning not defined in Ultra payload.' }));

    // "Honesty layer": make it explicit that this package preserves structure, not truth.
    const semantic_validation = {
      status: 'unverified',
      scope: 'structure_only',
      reason: 'Ultra+ does not include the full transcript; semantic correctness is not validated.',
      recommended_checks: [
        'List the hidden assumptions required for the decisions to be correct.',
        'Find at least 3 counterexamples / contradictions to the implied reasoning.',
        'State what evidence would change the conclusion (falsifiability).'
      ]
    };

    // Extract a few assumption-like statements (if explicitly stated) from the live messages.
    // This is still lossy: we only keep short excerpts and we do NOT claim they are true.
    const assumptions_candidates = [];
    const looksLikeCodeOrLogs = (text) => {
      const t = String(text || '').trim();
      if (!t) return false;
      // Very long single-line blobs are almost always code/log dumps (CSS, minified, stack traces)
      const lines = t.split(/\r?\n/);
      const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
      if (longest > 240) return true;
      // Common signals for shell/code/log noise
      if (/^\s*(\$|#|>|\w+@[\w.-]+).*%?\s/.test(t)) return true; // prompts
      if (/\b(import|export|const|let|var|function|class|def|async|await|return)\b/.test(t)) return true;
      if (/^\s*#!/.test(t)) return true;
      if (/(Traceback|Exception|Error:|stack|at\s+\w+\s+\(|VM\d+:)/i.test(t)) return true;
      if (/[{}[\];]{6,}/.test(t)) return true;
      if (/\/Users\/|\\Users\\|\/home\/|C:\\\\/.test(t)) return true; // paths
      return false;
    };
    const assumptionMarkers = [
      /\b(assume|assumption|hypothesis|suppose|let's\s+assume|we\s+assume)\b/i,
      /\b(hypoth[eè]se|supposons|on\s+suppose|admettons)\b/i
    ];
    for (const m of messages) {
      const text = String(m?.content || '').trim();
      if (!text) continue;
      // Avoid huge dumps (often nested JSON / code); Ultra+ should stay light.
      if (text.length > 1200) continue;
      if (looksLikeCodeOrLogs(text)) continue;
      const cleaned = this._excerpt(text);
      if (!cleaned) continue;
      if (!assumptionMarkers.some((re) => re.test(cleaned))) continue;
      assumptions_candidates.push(cleaned);
      if (assumptions_candidates.length >= 6) break;
    }

    // Semantic spine (Ultra+ hybrid): a tiny, non-inventive “why/how to continue” layer.
    const findMainTension = () => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (String(m?.role || '') !== 'user') continue;
        const t = String(m?.content || '');
        if (!t) continue;
        if (looksLikeCodeOrLogs(t)) continue;
        // Prefer explicit questions / blockers (most recent)
        if (/\?/.test(t) || /\b(error|fails?|broken|cannot|can't|doesn't|issue|problem|blocked)\b/i.test(t)) {
          return this._excerpt(t, 160);
        }
      }
      return 'UNKNOWN';
    };

    const open_questions = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || '') !== 'user') continue;
      const t = String(m?.content || '').trim();
      if (!t) continue;
      if (!/\?/.test(t)) continue;
      if (looksLikeCodeOrLogs(t)) continue;
      const ex = this._excerpt(t, 160);
      if (!ex || ex === 'UNKNOWN') continue;
      if (open_questions.includes(ex)) continue;
      open_questions.push(ex);
      if (open_questions.length >= 5) break;
    }

    // Use the first (strongest) decision as the “key decision”.
    const primaryDecision =
      decisions.find((d) => {
        const c = String(d?.choice || '');
        return c && c !== 'UNKNOWN' && c.length >= 24;
      }) || decisions[0] || null;
    const falsifyIf = checklist[0] || 'UNKNOWN';

    // Rejected alternatives (best effort) from the raw decision options.
    const rejected_alternatives = [];
    if (rawDecisions.length) {
      const rd = rawDecisions.find((d) => String(d?.id || '') === String(primaryDecision?.id || '')) || rawDecisions[0];
      const chosen = String(rd?.chosen_option || '').trim();
      const opts = Array.isArray(rd?.options_considered) ? rd.options_considered : [];
      for (const o of opts) {
        const opt = String(o?.option || '').trim();
        if (!opt) continue;
        if (chosen && opt === chosen) continue;
        const ex = this._excerpt(opt, 120);
        if (!ex) continue;
        if (rejected_alternatives.includes(ex)) continue;
        rejected_alternatives.push(ex);
        if (rejected_alternatives.length >= 3) break;
      }
    }

    const semantic_spine = {
      core_context: context_summary_ultra || 'UNKNOWN',
      main_tension: findMainTension(),
      key_decision: {
        statement: primaryDecision ? String(primaryDecision.choice || '') : 'UNKNOWN',
        why: primaryDecision ? String(primaryDecision.rationale || '') : 'No high-confidence decisions extracted.',
        choice_sha256: primaryDecision ? String(primaryDecision.choice_sha256 || '') : '',
        falsify_if: falsifyIf
      },
      assumptions: assumptions_candidates.length ? assumptions_candidates.slice(0, 5) : ['UNKNOWN'],
      rejected_alternatives: rejected_alternatives.length ? rejected_alternatives : [],
      open_questions: open_questions.length ? open_questions : []
    };

    return {
      context_summary_ultra,
      validation_checklist: checklist,
      unknowns,
      semantic_validation,
      assumptions_candidates,
      semantic_spine
    };
  }

  /**
   * Generate partial snapshot when budget exceeded
   * @param {string} reason
   * @param {Object} partialData
   * @returns {Object}
   */
  generatePartialSnapshot(reason, partialData = {}) {
    const nowIso = new Date().toISOString();
    const sessionId = this._pickSessionId(nowIso);
    const base = {
      version: '0.1.0',
      session_id: sessionId,
      timestamp: nowIso,
      partial: true,
      partial_reason: reason,
      topics: [],
      decisions: [],
      insights: [],
      context_summary: '',
      // Keep raw messages in partial mode (debugging / safety).
      messages: this.messages.map((m) => ({ ...m, session_id: sessionId })), // normalize ids
      metadata: {
        messages: this.messages.length,
        bundle_ratio: 'N/A (partial)',
        compression: 'N/A (partial)',
        generated: nowIso
      },
      checksum: ''
    };
    const snap = { ...base, ...partialData };
    return snap;
  }

  /**
   * Extract 5-10 topics with weights.
   * @returns {Array<{label:string, weight:number, message_refs:string[], summary:string}>}
   */
  extractTopics() {
    try {
      if (typeof extractTopics !== 'function') return [];
      const topics = extractTopics(this.messages);
      return Array.isArray(topics) ? topics : [];
    } catch (e) {
      console.error('[RL4]', 'extractTopics failed', e);
      return [];
    }
  }

  /**
   * Extract topics with metadata (proof-grade).
   * @returns {{topics: Array<{label:string, weight:number, message_refs:string[], summary:string}>, meta: {method:string, quality:string, status:string, reason:string[]}}}
   */
  extractTopicsWithMeta() {
    try {
      if (typeof extractTopicsWithMeta === 'function') {
        return extractTopicsWithMeta(this.messages);
      }
      // Fallback to basic extractTopics with default meta
      const topics = this.extractTopics();
      return {
        topics,
        meta: {
          method: 'tfidf_v1',
          quality: topics.length > 0 ? 'ok' : 'degraded',
          status: topics.length > 0 ? 'extracted' : 'empty',
          reason: topics.length > 0 ? ['fallback_no_meta_function'] : ['no_topics_extracted', 'fallback_no_meta_function']
        }
      };
    } catch (e) {
      console.error('[RL4]', 'extractTopicsWithMeta failed', e);
      return {
        topics: [],
        meta: {
          method: 'tfidf_v1',
          quality: 'degraded',
          status: 'empty',
          reason: ['extraction_error']
        }
      };
    }
  }

  /**
   * Extract decisions with pattern matching.
   * @returns {Array<any>}
   */
  extractDecisions() {
    try {
      if (typeof extractDecisions !== 'function') return [];
      const decisions = extractDecisions(this.messages);
      return Array.isArray(decisions) ? decisions : [];
    } catch (e) {
      console.error('[RL4]', 'extractDecisions failed', e);
      return [];
    }
  }

  /**
   * Extract key insights.
   * @returns {string[]}
   */
  extractInsights() {
    try {
      if (typeof extractInsights !== 'function') return [];
      const insights = extractInsights(this.messages);
      return Array.isArray(insights) ? insights : [];
    } catch (e) {
      console.error('[RL4]', 'extractInsights failed', e);
      return [];
    }
  }

  /**
   * V2: Extract constraints (DON'T/DO/technical limitations).
   * @returns {{dont: string[], do: string[], technical: string[], performance: string[], security: string[]}}
   */
  extractConstraints() {
    try {
      if (typeof extractConstraints !== 'function') {
        return { dont: [], do: [], technical: [], performance: [], security: [] };
      }
      const constraints = extractConstraints(this.messages);
      return constraints || { dont: [], do: [], technical: [], performance: [], security: [] };
    } catch (e) {
      console.error('[RL4]', 'extractConstraints failed', e);
      return { dont: [], do: [], technical: [], performance: [], security: [] };
    }
  }

  /**
   * Generate compact summary (max 200 chars).
   * @param {{topics:any[], decisions:any[]}} data
   * @returns {string}
   */
  generateSummary(data) {
    const n = this.messages.length;
    const topTopics = (data.topics || []).slice(0, 3).map((t) => t.label).join(', ');
    const keyDecisions = (data.decisions || []).slice(0, 2).map((d) => d.intent).join(', ');

    let summary = `${n} messages. Topics: ${topTopics || 'none'}. Decisions: ${keyDecisions || 'none'}.`;
    if (summary.length > 200) {
      summary = summary.slice(0, 197) + '...';
    }
    return summary;
  }

  /**
   * Deduplicate messages: remove exact duplicates and filter system messages
   * Keep messages referenced by topics/decisions + unique messages
   * @param {Array} messages
   * @param {Array} topics
   * @param {Array} decisions
   * @returns {Array}
   */
  _deduplicateMessages(messages, topics, decisions) {
    // Collect message IDs referenced by topics/decisions
    const referencedIds = new Set();
    for (const topic of topics || []) {
      for (const ref of topic.message_refs || []) {
        referencedIds.add(ref);
      }
    }
    for (const decision of decisions || []) {
      // Decisions don't have message_refs, but we keep all messages for now
    }

    // Filter system messages (common repetitive patterns)
    const systemPatterns = [
      /Pour exécuter du code, activez l'exécution/i,
      /Pour exécuter du code, activez/i,
      /activez l'exécution de code/i,
      /Paramètres > Capacités/i
    ];

    const seen = new Map(); // content -> first message with this content
    const unique = [];

    for (const msg of messages) {
      const content = (msg.content || '').trim();
      if (!content) continue;

      // Skip system messages
      if (systemPatterns.some((pattern) => pattern.test(content))) {
        continue;
      }

      // Deduplicate: if same content seen before, skip
      const contentKey = content.toLowerCase().slice(0, 200); // First 200 chars for comparison
      if (seen.has(contentKey)) {
        // If this message is referenced, keep it instead of the duplicate
        if (referencedIds.has(msg.id)) {
          const prevIndex = unique.findIndex((m) => seen.get(contentKey) === m.id);
          if (prevIndex >= 0) {
            unique.splice(prevIndex, 1);
            unique.push(msg);
            seen.set(contentKey, msg.id);
          }
        }
        continue;
      }

      seen.set(contentKey, msg.id);
      unique.push(msg);
    }

    return unique;
  }

  /**
   * Encode the full conversation as a single compact string (LLM-readable, no binary).
   * Format:
   *   USER:
   *   ...
   *
   *   <|RL4_MSG|>
   *
   *   ASSISTANT:
   *   ...
   *
   * @param {Array<{role:'user'|'assistant', content:string}>} messages
   * @returns {string}
   */
  _encodeMessagesCompact(messages) {
    const SEP = '\n\n<|RL4_MSG|>\n\n';
    const out = [];
    for (const m of messages || []) {
      const role = m.role === 'user' ? 'USER' : 'ASSISTANT';
      const content = String(m.content || '').trim();
      if (!content) continue;
      out.push(`${role}:\n${content}`);
    }
    return out.join(SEP);
  }

  /**
   * SHA-256 hex for a string (used for transcript fingerprint).
   * @param {string} text
   * @returns {Promise<string>}
   */
  async _sha256Hex(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(String(text || ''));
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Minimal, non-hallucinated timeline: chunk by message ranges and keep ultra-short excerpts.
   * @param {Array<{role:'user'|'assistant', content:string}>} messages
   * @returns {Array<{range:string, summary:string}>}
   */
  _timelineSummary(messages) {
    const n = Array.isArray(messages) ? messages.length : 0;
    if (!n) return [];
    const chunks = [];
    const size = n <= 12 ? 4 : n <= 30 ? 6 : 8;
    for (let i = 0; i < n; i += size) {
      const start = i + 1;
      const end = Math.min(n, i + size);
      const slice = messages.slice(i, end);
      const first = slice[0];
      const last = slice[slice.length - 1];
      const firstHint = this._excerpt(first?.content || '');
      const lastHint = this._excerpt(last?.content || '');
      chunks.push({
        range: `${start}-${end}`,
        summary: `From: ${first?.role || 'unknown'}(${firstHint}) → To: ${last?.role || 'unknown'}(${lastHint})`
      });
    }
    return chunks;
  }

  /**
   * Build capture_bounds: centralized proof-grade metadata about the capture.
   * Generated by RL4, not LLM - all facts, no interpretation.
   * @param {{messages: Array<{timestamp?:string}>, evidence: any, transcriptSha256: string, transcriptFormat: string, transcriptIncluded: boolean, captureSource: string}} params
   * @returns {{earliest_ts:string, latest_ts:string, threads_count:number, messages_count:number, capture_source:string, capture_completeness:string, evidence_status:string, evidence_checksum:string, transcript_ref:{sha256:string, format:string, included:boolean}}}
   */
  _buildCaptureBounds(params) {
    const messages = Array.isArray(params?.messages) ? params.messages : [];
    const evidence = params?.evidence || null;
    const transcriptSha256 = params?.transcriptSha256 || '';
    const transcriptFormat = params?.transcriptFormat || '';
    const transcriptIncluded = !!params?.transcriptIncluded;
    const captureSource = params?.captureSource || 'cursor_chat_v1';
    
    // Extract timestamps
    const timestamps = messages
      .map(m => m?.timestamp)
      .filter(Boolean)
      .map(ts => new Date(ts))
      .filter(d => !isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    
    const earliestTs = timestamps.length > 0 ? timestamps[0].toISOString() : '';
    const latestTs = timestamps.length > 0 ? timestamps[timestamps.length - 1].toISOString() : '';
    
    // Count unique threads/sessions
    const sessions = new Set(messages.map(m => m?.session_id).filter(Boolean));
    const threadsCount = Math.max(1, sessions.size);
    
    // Determine capture completeness
    let captureCompleteness = 'full';
    if (evidence?.pack?.partial) {
      captureCompleteness = 'partial';
    } else if (messages.length > 500) {
      captureCompleteness = 'tail_only'; // Large conversations may be truncated
    }
    
    // Evidence status
    const evidenceStatus = evidence?.status || 'skipped';
    const evidenceChecksum = evidence?.checksum || '';
    
    return {
      earliest_ts: earliestTs,
      latest_ts: latestTs,
      threads_count: threadsCount,
      messages_count: messages.length,
      capture_source: captureSource,
      capture_completeness: captureCompleteness,
      evidence_status: evidenceStatus,
      evidence_checksum: evidenceChecksum,
      transcript_ref: {
        sha256: transcriptSha256,
        format: transcriptFormat,
        included: transcriptIncluded
      }
    };
  }

  /**
   * Build decision analysis stats (structural, no text matching).
   * Purely mechanical: counts, ratios, lengths - no semantic interpretation.
   * @param {Array<{id:string, chosen_option:string, decision_quality?:string, chosen_option_truncated?:boolean, context_refs?:string[]}>} decisions
   * @returns {{count:number, implicit_ratio:number, truncated_ratio:number, length_chars:{min:number, median:number, max:number}, context_refs_ratio:number}}
   */
  _buildDecisionAnalysis(decisions) {
    const list = Array.isArray(decisions) ? decisions : [];
    const count = list.length;
    
    if (count === 0) {
      return {
        count: 0,
        implicit_ratio: 0,
        truncated_ratio: 0,
        length_chars: { min: 0, median: 0, max: 0 },
        context_refs_ratio: 0
      };
    }
    
    // Count implicit decisions (quality != 'explicit')
    const implicitCount = list.filter(d => 
      String(d?.decision_quality || 'weak') !== 'explicit'
    ).length;
    const implicitRatio = Math.round((implicitCount / count) * 100) / 100;
    
    // Count truncated decisions
    const truncatedCount = list.filter(d => d?.chosen_option_truncated === true).length;
    const truncatedRatio = Math.round((truncatedCount / count) * 100) / 100;
    
    // Calculate chosen_option lengths
    const lengths = list
      .map(d => String(d?.chosen_option || '').length)
      .filter(l => l > 0)
      .sort((a, b) => a - b);
    
    const minLen = lengths.length > 0 ? lengths[0] : 0;
    const maxLen = lengths.length > 0 ? lengths[lengths.length - 1] : 0;
    const medianLen = lengths.length > 0 
      ? lengths[Math.floor(lengths.length / 2)] 
      : 0;
    
    // Count decisions with context_refs
    const withRefsCount = list.filter(d => 
      Array.isArray(d?.context_refs) && d.context_refs.length > 0
    ).length;
    const contextRefsRatio = Math.round((withRefsCount / count) * 100) / 100;
    
    return {
      count,
      implicit_ratio: implicitRatio,
      truncated_ratio: truncatedRatio,
      length_chars: { min: minLen, median: medianLen, max: maxLen },
      context_refs_ratio: contextRefsRatio
    };
  }

  /**
   * Build activity cycles using purely mechanical/temporal segmentation.
   * NO semantic labels, NO keywords - just structural facts about message distribution.
   * @param {Array<{role:string, content:string, timestamp?:string}>} messages
   * @param {{maxCycles?:number}} opts
   * @returns {Array<{range:string, event_count:number, unique_files:number, time_span_ms:number, churn_ratio:number, gap_before_ms:number}>}
   */
  _buildActivityCyclesMechanical(messages, opts = {}) {
    const n = Array.isArray(messages) ? messages.length : 0;
    if (!n) return [];
    
    const maxCycles = Math.max(3, Math.min(10, Number(opts.maxCycles) || 6));
    const cycleSize = Math.ceil(n / maxCycles);
    const cycles = [];
    
    // Extract timestamps if available
    const getTimestamp = (m) => {
      if (!m?.timestamp) return null;
      const ts = new Date(m.timestamp);
      return isNaN(ts.getTime()) ? null : ts.getTime();
    };
    
    // Extract mentioned files from content (mechanical, not semantic)
    const extractFiles = (content) => {
      const t = String(content || '');
      const files = new Set();
      // Match file-like patterns
      const fileRe = /(?:^|\s|`)([\w./-]+\.(?:ts|tsx|js|jsx|json|md|css|py|go|rs|java|html|vue|svelte))(?:\s|`|$)/gi;
      let m;
      while ((m = fileRe.exec(t)) !== null) {
        if (m[1]) files.add(m[1]);
      }
      return files;
    };
    
    let prevEndTs = null;
    
    for (let i = 0; i < n; i += cycleSize) {
      const start = i;
      const end = Math.min(n, i + cycleSize);
      const slice = messages.slice(start, end);
      
      // Count events
      const eventCount = slice.length;
      
      // Count unique files mentioned
      const allFiles = new Set();
      for (const m of slice) {
        for (const f of extractFiles(m?.content)) allFiles.add(f);
      }
      const uniqueFiles = allFiles.size;
      
      // Calculate time span (if timestamps available)
      const timestamps = slice.map(getTimestamp).filter(Boolean);
      let timeSpanMs = 0;
      let gapBeforeMs = 0;
      
      if (timestamps.length >= 2) {
        timeSpanMs = Math.max(...timestamps) - Math.min(...timestamps);
      }
      
      if (prevEndTs !== null && timestamps.length > 0) {
        gapBeforeMs = Math.min(...timestamps) - prevEndTs;
        if (gapBeforeMs < 0) gapBeforeMs = 0;
      }
      
      if (timestamps.length > 0) {
        prevEndTs = Math.max(...timestamps);
      }
      
      // Churn ratio: user messages / total messages (mechanical indicator of interaction density)
      const userMsgs = slice.filter(m => String(m?.role || '').toLowerCase() === 'user').length;
      const churnRatio = eventCount > 0 ? Math.round((userMsgs / eventCount) * 100) / 100 : 0;
      
      cycles.push({
        range: `${start + 1}-${end}`,
        event_count: eventCount,
        unique_files: uniqueFiles,
        time_span_ms: timeSpanMs,
        churn_ratio: churnRatio,
        gap_before_ms: gapBeforeMs
      });
    }
    
    return cycles;
  }

  /**
   * Macro timeline: group message index ranges into a few phases without inventing meaning.
   * @param {Array<{role:string, content:string}>} messages
   * @param {{maxPhases:number}} opts
   * @returns {Array<{phase:string, range:string, summary:string}>}
   */
  _timelineMacro(messages, opts = {}) {
    const n = Array.isArray(messages) ? messages.length : 0;
    if (!n) return [];
    const maxPhases = Math.max(3, Math.min(7, Number(opts.maxPhases) || 6));

    const size = Math.ceil(n / maxPhases);
    const phases = [];
    for (let i = 0; i < n; i += size) {
      const start = i + 1;
      const end = Math.min(n, i + size);
      const slice = messages.slice(i, end);
      const roles = slice.reduce(
        (acc, m) => {
          const r = m && m.role ? String(m.role) : 'unknown';
          acc[r] = (acc[r] || 0) + 1;
          return acc;
        },
        { user: 0, assistant: 0, unknown: 0 }
      );
      const keywords = this._phaseKeywords(slice, 2);
      const phaseNum = phases.length + 1;
      phases.push({
        phase: `Phase ${phaseNum}`,
        range: `${start}-${end}`,
        summary: keywords.length
          ? `Keywords: ${keywords.join(', ')} • user:${roles.user || 0}, assistant:${roles.assistant || 0}`
          : `Messages ${start}–${end} (user:${roles.user || 0}, assistant:${roles.assistant || 0})`
      });
    }
    return phases.slice(0, 7);
  }

  /**
   * Extract 1–N phase keywords from message slice (non-semantic, frequency-based).
   * This avoids "naming phases" (hallucination) while still giving useful anchors.
   * @param {Array<{content:string}>} slice
   * @param {number} limit
   * @returns {string[]}
   */
  _phaseKeywords(slice, limit = 2) {
    const STOP = new Set([
      // EN
      'this',
      'that',
      'with',
      'from',
      'have',
      'will',
      'your',
      'you',
      'and',
      'for',
      'are',
      'was',
      'were',
      'into',
      'about',
      'then',
      'what',
      'when',
      'where',
      'which',
      'who',
      'why',
      'how',
      'can',
      'could',
      'should',
      'would',
      'also',
      'just',
      'like',
      'make',
      'some',
      'more',
      'most',
      'very',
      'only',
      'not',
      'does',
      'did',
      'done',
      'been',
      'its',
      'our',
      'we',
      'i',
      'me',
      'my',
      // FR
      'avec',
      'pour',
      'dans',
      'comme',
      'plus',
      'moins',
      'aussi',
      'mais',
      'donc',
      'alors',
      'tres',
      'très',
      'tout',
      'toute',
      'tous',
      'toutes',
      'cette',
      'cela',
      'ceci',
      'etre',
      'être',
      'avoir',
      'faire',
      'fait',
      'faut',
      'vais',
      'va',
      // common chat/meta
      'message',
      'messages',
      'assistant',
      'user',
      'json',
      'rcep',
      'snapshot',
      'checksum',
      'sha256',
      // common dev-noise seen in this project’s chats
      'const',
      'content',
      'object',
      'ncontent',
      'option',
      'phase',
      'summary',
      'range'
    ]);

    const counts = new Map();
    const addTokens = (text) => {
      let t = String(text || '');
      t = t.replace(/```[\s\S]*?```/g, ' ');
      t = t.replace(/`[^`]*`/g, ' ');
      t = t.replace(/\bhttps?:\/\/\S+/gi, ' ');
      t = t.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!t) return;
      // Keep unicode letters/numbers, split on non-word-ish
      const tokens = t
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .split(/\s+/)
        .map((w) => w.trim())
        .filter(Boolean);
      for (const w of tokens) {
        if (w.length < 5) continue;
        if (STOP.has(w)) continue;
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    };

    for (const m of slice || []) addTokens(m && m.content ? m.content : '');

    const scored = [...counts.entries()]
      .map(([w, c]) => ({ w, c }))
      .sort((a, b) => b.c - a.c)
      .slice(0, Math.max(0, Number(limit) || 2))
      .map((x) => x.w);

    return scored;
  }

  _excerpt(text, maxLen = 80) {
    // Keep excerpts clean for any LLM (strip code/markdown noise)
    let t = String(text || '');
    t = t.replace(/```[\s\S]*?```/g, ' ');
    t = t.replace(/`[^`]*`/g, ' ');
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ' ');
    // Remove emojis / pictographs (keeps injection text clean)
    try {
      t = t.replace(/\p{Extended_Pictographic}/gu, '');
    } catch (_) {
      // older engines: ignore
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const n = Math.max(24, Number(maxLen) || 80);
    return t.length > n ? t.slice(0, Math.max(0, n - 3)) + '...' : t;
  }

  /**
   * Compress messages JSON with gzip (browser CompressionStream API)
   * @param {string} jsonString
   * @returns {Promise<string>} Base64 encoded compressed data
   */
  async _compressMessages(jsonString) {
    // Use CompressionStream API (available in modern browsers)
    const stream = new CompressionStream('gzip');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    // Write data
    const encoder = new TextEncoder();
    writer.write(encoder.encode(jsonString));
    writer.close();

    // Read compressed chunks
    const chunks = [];
    let done = false;
    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) chunks.push(value);
    }

    // Combine chunks and convert to base64
    const compressed = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      compressed.set(chunk, offset);
      offset += chunk.length;
    }

    // Convert to base64
    const base64 = btoa(String.fromCharCode(...compressed));
    return base64;
  }

  /**
   * originalSize = sum(message.content.length)
   * compressedSize = snapshot JSON size
   * @param {number} originalSize
   * @param {number} compressedSize
   * @returns {string}
   */
  calculateCompressionRatio(originalSize, compressedSize) {
    if (!compressedSize || compressedSize <= 0) return '0x';
    const ratio = originalSize / compressedSize;
    if (!isFinite(ratio) || ratio <= 0) return '0x';
    return `${ratio.toFixed(1)}x`;
  }

  // ============================================================================
  // TIME MACHINE V1.2 - Extract activity data from evidence pack
  // ============================================================================

  /**
   * Extract Time Machine data from evidence pack.
   * Returns null if no time machine data is available.
   * 
   * @param {object|null} evidence - Evidence object from _extractEvidenceFromMessages
   * @returns {object|null} - Time machine data or null
   */
  _extractTimeMachineData(evidence) {
    if (!evidence || !evidence.pack) return null;
    
    const pack = evidence.pack;
    
    // Check for V1.2 time machine fields
    const hasBursts = Array.isArray(pack.bursts) && pack.bursts.length > 0;
    const hasCausalLinks = Array.isArray(pack.causal_links) && pack.causal_links.length > 0;
    const hasSystemHealth = pack.system_health && typeof pack.system_health === 'object';
    
    // If no V1.2 data, return null (backward compatible)
    if (!hasBursts && !hasCausalLinks && !hasSystemHealth) {
      // Try to build minimal activity summary from V1.0 data
      return this._buildMinimalActivitySummary(pack);
    }
    
    // Build activity summary
    const activitySummary = this._buildActivitySummaryFromPack(pack);
    
    // Extract bursts (limit to most recent 10)
    const bursts = (pack.bursts || []).slice(-10).map(b => ({
      burst_id: b.burst_id,
      t: b.t,
      files: b.files || [],
      pattern: b.pattern || { type: 'unknown', confidence: 0 },
      events_count: b.events_count || 0
    }));
    
    // Extract causal links (limit to most recent 10)
    const causalLinks = (pack.causal_links || []).slice(-10).map(cl => ({
      chat_ref: cl.chat_ref,
      file: cl.file,
      delay_sec: Math.round((cl.delay_ms || 0) / 1000),
      confidence: cl.confidence?.level || 'unknown'
    }));
    
    // Build trace pointers
    const tracePointers = {
      file_events: '.rl4_evidence_v1/file_changes.jsonl',
      burst_stats: '.rl4_evidence_v1/burst_stats.jsonl',
      causal_links: '.rl4_evidence_v1/causal_links.jsonl',
      daily_timelines: '.rl4_evidence_v1/daily_timelines/',
      temporal_index: '.rl4_evidence_v1/temporal_index.json'
    };
    
    // System health
    const systemHealth = pack.system_health || {
      clock_sanity: 'unknown',
      timezone_offset_minutes: 0
    };
    
    return {
      activity_summary: activitySummary,
      bursts,
      causal_links: causalLinks,
      trace_pointers: tracePointers,
      system_health: systemHealth
    };
  }

  /**
   * Build activity summary from V1.2 evidence pack
   */
  _buildActivitySummaryFromPack(pack) {
    const bursts = pack.bursts || [];
    const causalLinks = pack.causal_links || [];
    const fileEvents = pack.recent_file_events || [];
    
    // Count patterns
    const patternCounts = {};
    for (const b of bursts) {
      const type = b.pattern?.type || 'unknown';
      patternCounts[type] = (patternCounts[type] || 0) + 1;
    }
    
    // Build pattern summary string
    const patternSummary = Object.entries(patternCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type}: ${count}`)
      .join(', ');
    
    // Get unique files
    const filesModified = new Set();
    for (const e of fileEvents) {
      if (e.path) filesModified.add(e.path);
      if (e.to) filesModified.add(e.to);
    }
    
    // Find peak hour (if we have timestamps)
    let peakHour = null;
    if (fileEvents.length > 0) {
      const hourCounts = {};
      for (const e of fileEvents) {
        try {
          const hour = new Date(e.t).getHours();
          hourCounts[hour] = (hourCounts[hour] || 0) + 1;
        } catch {}
      }
      const maxHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];
      if (maxHour) peakHour = parseInt(maxHour[0]);
    }
    
    return {
      files_modified: filesModified.size,
      bursts_count: bursts.length,
      patterns: patternSummary || 'none',
      causal_links_count: causalLinks.length,
      peak_hour: peakHour,
      file_events_count: fileEvents.length
    };
  }

  /**
   * Build minimal activity summary from V1.0 evidence pack (backward compatible)
   */
  _buildMinimalActivitySummary(pack) {
    const fileEvents = pack.recent_file_events || [];
    const ideActivity = pack.ide_activity;
    
    if (fileEvents.length === 0 && !ideActivity) return null;
    
    // Get unique files
    const filesModified = new Set();
    for (const e of fileEvents) {
      if (e.path) filesModified.add(e.path);
      if (e.to) filesModified.add(e.to);
    }
    
    return {
      activity_summary: {
        files_modified: filesModified.size,
        bursts_count: 0,
        patterns: 'not_tracked',
        causal_links_count: 0,
        peak_hour: null,
        file_events_count: fileEvents.length
      },
      bursts: [],
      causal_links: [],
      trace_pointers: {
        file_events: '.rl4_evidence_v1/file_changes.jsonl',
        ide_activity: '.rl4_evidence_v1/ide_activity.jsonl'
      },
      system_health: {
        clock_sanity: 'unknown',
        timezone_offset_minutes: 0
      }
    };
  }

  // ============================================================================
  // COGNITIVE PROCESSING - V2.0 Semantic Enhancement
  // ============================================================================

  /**
   * Build cognitive days from messages using thematic pivot detection.
   * Uses Jaccard similarity to detect topic shifts.
   * @param {Array<{id:string, role:string, content:string, timestamp?:string}>} messages
   * @param {Object} options
   * @returns {Array<{day_id:string, focus:string, key_shift:string, decisions_in_scope:string[], messages_range:{start:number, end:number}}>}
   */
  _buildCognitiveDays(messages, options = {}) {
    try {
      if (typeof splitIntoCognitiveDays === 'function') {
        return splitIntoCognitiveDays(messages, options);
      }
      // Fallback: return empty array if module not loaded
      return [];
    } catch (e) {
      console.error('[RL4]', '_buildCognitiveDays failed', e);
      return [];
    }
  }

  /**
   * Build causal chains from decisions and evidence.
   * Traces trigger → decision → implementation → outcome.
   * @param {Array} decisions
   * @param {Object} evidence
   * @param {Array} insights
   * @param {Object} options
   * @returns {Array<{chain_id:string, trigger:Object, decision:Object, implementation:Object, outcome:Object, impact_score:number}>}
   */
  _buildCausalChainsFromData(decisions, evidence, insights, options = {}) {
    try {
      if (typeof buildCausalChains === 'function') {
        return buildCausalChains(decisions, evidence, insights, options);
      }
      // Fallback: return empty array if module not loaded
      return [];
    } catch (e) {
      console.error('[RL4]', '_buildCausalChainsFromData failed', e);
      return [];
    }
  }

  /**
   * Build progressive summary with 3 levels.
   * L1 (glance): 1 sentence, max 100 chars
   * L2 (context): 3-5 sentences, max 500 chars
   * L3 (detailed): day-by-day with decisions
   * @param {Object} params
   * @returns {{L1:string, L2:string, L3:Array}}
   */
  _buildProgressiveSummaryFromData(params) {
    try {
      if (typeof buildProgressiveSummary === 'function') {
        return buildProgressiveSummary(params);
      }
      // Fallback: minimal summary
      return {
        L1: params.contextSummary ? String(params.contextSummary).slice(0, 100) : 'Context captured.',
        L2: params.contextSummary || 'Session captured.',
        L3: []
      };
    } catch (e) {
      console.error('[RL4]', '_buildProgressiveSummaryFromData failed', e);
      return { L1: 'Context captured.', L2: 'Session captured.', L3: [] };
    }
  }
}

// Expose globally for popup.html simple script loading (no bundler).
// eslint-disable-next-line no-undef
if (typeof window !== 'undefined') {
  window.RL4SnapshotGenerator = RL4SnapshotGenerator;
}


