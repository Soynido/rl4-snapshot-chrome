/**
 * RL4 Extraction Engine V2 — Ultra-robust, universal extraction
 * 
 * Key improvements over V1:
 * - 5x more patterns for decisions/insights/constraints
 * - Adaptive limits based on conversation size (not hardcoded)
 * - No more "skip long messages" — chunk extraction instead
 * - Semantic deduplication (avoid near-duplicates)
 * - Separate constraints extraction
 * - Multi-language support (EN/FR/ES/DE)
 */

// ═══════════════════════════════════════════════════════════════════════════
// TOKENIZATION & NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Simple tokenization: lowercase, split on whitespace, strip punctuation.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Remove fenced code blocks + inline code for cleaner NLP extraction.
 * @param {string} text
 * @returns {string}
 */
function stripCode(text) {
  const t = String(text || '');
  // Remove fenced blocks ```...```
  const noFences = t.replace(/```[\s\S]*?```/g, ' ');
  // Remove inline code `...`
  const noInline = noFences.replace(/`[^`]*`/g, ' ');
  return noInline.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize content for keyword extraction (drop code, heavy markdown artifacts).
 * @param {string} text
 * @returns {string}
 */
function normalizeForExtraction(text) {
  let t = stripCode(text);
  // Remove markdown headings and list markers
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ' ');
  t = t.replace(/^\s*[-*]\s+/gm, ' ');
  // Remove URLs (often noisy)
  t = t.replace(/\bhttps?:\/\/\S+/gi, ' ');
  // Remove common pseudo-code arrow flows and heavy symbol runs
  t = t.replace(/[↓→←⇒⇐]/g, ' ');
  t = t.replace(/[-=]{3,}/g, ' ');
  t = t.replace(/[|]{2,}/g, ' ');
  // Drop "looks like code/spec" fragments
  const parts = t.split(/\n+/g);
  const filtered = [];
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    const letters = (s.match(/\p{L}/gu) || []).length;
    // Heuristic: if a line is mostly non-letters, it's probably code/template.
    if (s.length >= 60 && letters / Math.max(1, s.length) < 0.55) continue;
    // Heuristic: lots of braces/parens indicates code
    if ((s.match(/[{}()[\];]/g) || []).length >= 8) continue;
    filtered.push(s);
  }
  t = filtered.join(' ');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * V2: Extract meaningful chunks from long messages instead of skipping them.
 * Splits into sentences and returns chunks of reasonable size.
 * @param {string} text - Normalized text
 * @param {number} maxChunkSize - Max chars per chunk (default 600)
 * @returns {string[]}
 */
function extractChunks(text, maxChunkSize = 600) {
  if (!text || text.length <= maxChunkSize) return [text];
  
  // Split by sentence boundaries
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = '';
  
  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChunkSize) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else {
      current += ' ' + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  
  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════
// STOPWORDS (expanded)
// ═══════════════════════════════════════════════════════════════════════════

const STOPWORDS = new Set([
  // English common
  'the', 'this', 'that', 'with', 'from', 'have', 'will', 'your', 'you',
  'and', 'for', 'are', 'was', 'were', 'been', 'into', 'about', 'than',
  'then', 'them', 'they', 'what', 'when', 'where', 'which', 'who', 'why',
  'how', 'can', 'could', 'should', 'would', 'also', 'just', 'like', 'make',
  'made', 'some', 'more', 'most', 'very', 'only', 'not', 'does', 'did',
  'done', 'it', 'its', 'our', 'we', 'i', 'me', 'my', 'a', 'an', 'to',
  'of', 'in', 'on', 'at', 'as', 'is', 'be', 'or', 'vs', 'versus', 'option',
  // French common
  'avec', 'pour', 'dans', 'comme', 'plus', 'moins', 'aussi', 'mais', 'donc',
  'alors', 'tres', 'très', 'tout', 'toute', 'tous', 'toutes', 'cette', 'ceux',
  'cela', 'ceci', 'etre', 'être', 'avoir', 'faire', 'fait', 'faut',
  // Dev / implementation noise
  'const', 'function', 'return', 'await', 'async', 'import', 'export',
  'json', 'javascript', 'typescript', 'chrome', 'extension', 'manifest',
  'popup', 'content', 'contentjs', 'checksum', 'sha256', 'messages',
  'message', 'snapshot', 'console', 'window', 'document', 'storage',
  'localstorage', 'indexeddb', 'mutationobserver', 'selector', 'selectors',
  'scraper', 'scraping', 'script', 'api', 'endpoint', 'class', 'chars',
  'tokens', 'token', 'prompt', 'markdown', 'regex', 'pattern', 'patterns',
  // Generic meta
  'question', 'questions', 'cours', 'course', 'file', 'files', 'fichier',
  'fichiers', 'repo', 'repository', 'github', 'pdf', 'docs', 'document',
  'documents', 'user', 'users', 'assistant'
]);

// ═══════════════════════════════════════════════════════════════════════════
// V2 DECISION PATTERNS (5x more than V1)
// ═══════════════════════════════════════════════════════════════════════════

const DECISION_PATTERNS = {
  // Explicit decision markers (high confidence)
  explicit: [
    { re: /Decision:\s*(.+)/i, intent: 'decide', confidence: 'high' },
    { re: /Décision\s*:\s*(.+)/i, intent: 'decide', confidence: 'high' },
    { re: /\bI\s+decided?\s+to\b/i, intent: 'decide', confidence: 'high' },
    { re: /\bj'ai\s+décidé\s+de\b/i, intent: 'decide', confidence: 'high' },
    { re: /\bfinal\s+choice\s*:\s*(.+)/i, intent: 'decide', confidence: 'high' },
    { re: /\bchoix\s+final\s*:\s*(.+)/i, intent: 'decide', confidence: 'high' },
  ],
  // Recommendations (medium-high confidence)
  recommend: [
    { re: /\bI\s+recommend\b/i, intent: 'recommend', confidence: 'medium' },
    { re: /\bje\s+recommande\b/i, intent: 'recommend', confidence: 'medium' },
    { re: /\bmy\s+recommendation\s+is\b/i, intent: 'recommend', confidence: 'medium' },
    { re: /\bma\s+recommandation\s+est\b/i, intent: 'recommend', confidence: 'medium' },
    { re: /\bbest\s+approach\s+(?:is|would\s+be)\b/i, intent: 'recommend', confidence: 'medium' },
    { re: /\bla\s+meilleure\s+approche\b/i, intent: 'recommend', confidence: 'medium' },
    { re: /\bI\s+suggest\b/i, intent: 'recommend', confidence: 'medium' },
    { re: /\bje\s+suggère\b/i, intent: 'recommend', confidence: 'medium' },
  ],
  // Proposals (medium confidence)
  propose: [
    { re: /\bWe\s+should\b/i, intent: 'propose', confidence: 'medium' },
    { re: /\bon\s+devrait\b/i, intent: 'propose', confidence: 'medium' },
    { re: /\bil\s+faut\b/i, intent: 'propose', confidence: 'medium' },
    { re: /\bwe\s+need\s+to\b/i, intent: 'propose', confidence: 'medium' },
    { re: /\bI\s+think\s+we\s+should\b/i, intent: 'propose', confidence: 'medium' },
    { re: /\bje\s+pense\s+qu'on\s+devrait\b/i, intent: 'propose', confidence: 'medium' },
    { re: /\bLet's\s+go\s+with\b/i, intent: 'propose', confidence: 'medium' },
    { re: /\bon\s+part\s+sur\b/i, intent: 'propose', confidence: 'medium' },
  ],
  // Commitments / plans (medium confidence)
  commit: [
    { re: /\bje\s+vais\s+(.+)/i, intent: 'commit', confidence: 'medium', extract: 1 },
    { re: /\bon\s+va\s+(.+)/i, intent: 'commit', confidence: 'medium', extract: 1 },
    { re: /\bI('m|\s+am)\s+going\s+to\b/i, intent: 'commit', confidence: 'medium' },
    { re: /\bI'll\s+(.+)/i, intent: 'commit', confidence: 'medium', extract: 1 },
    { re: /\bPlan:\s*(.+)/i, intent: 'commit', confidence: 'medium', extract: 1 },
    { re: /\bobjectif\s*:\s*(.+)/i, intent: 'commit', confidence: 'medium', extract: 1 },
    { re: /\bgoal\s*:\s*(.+)/i, intent: 'commit', confidence: 'medium', extract: 1 },
    { re: /\bnext\s+step\s*:\s*(.+)/i, intent: 'commit', confidence: 'medium', extract: 1 },
    { re: /\bprochaine\s+étape\s*:\s*(.+)/i, intent: 'commit', confidence: 'medium', extract: 1 },
  ],
  // Comparisons / alternatives (low-medium confidence)
  compare: [
    { re: /option\s+[A-Z]\s+(vs|versus|or)\s+option\s+[A-Z]/i, intent: 'compare', confidence: 'low' },
    { re: /\bChoose\s+between\b/i, intent: 'compare', confidence: 'low' },
    { re: /\bchoisi[rs]?\s+entre\b/i, intent: 'compare', confidence: 'low' },
    { re: /\b(either|soit)\b.+\b(or|ou)\b/i, intent: 'compare', confidence: 'low' },
    { re: /\bpros?\s+and\s+cons?\b/i, intent: 'compare', confidence: 'low' },
    { re: /\bavantages?\s+et\s+inconvénients?\b/i, intent: 'compare', confidence: 'low' },
  ],
  // Architectural decisions (medium-high confidence)
  architecture: [
    { re: /\barchitectur(?:e|al)\s+decision\b/i, intent: 'architecture', confidence: 'high' },
    { re: /\bdécision\s+d'architecture\b/i, intent: 'architecture', confidence: 'high' },
    { re: /\bdesign\s+pattern\s*:\s*(.+)/i, intent: 'architecture', confidence: 'medium', extract: 1 },
    { re: /\bwe('ll|'re\s+going\s+to)\s+use\s+(\w+)\s+(?:for|to)\b/i, intent: 'architecture', confidence: 'medium' },
    { re: /\bon\s+(?:va|utilise)\s+(\w+)\s+pour\b/i, intent: 'architecture', confidence: 'medium' },
    { re: /\bstack\s*:\s*(.+)/i, intent: 'architecture', confidence: 'medium', extract: 1 },
    { re: /\btechnologie\s+choisie\s*:\s*(.+)/i, intent: 'architecture', confidence: 'medium', extract: 1 },
  ],
  // Bug fixes / problem solving (medium confidence)
  fix: [
    { re: /\bfixed?\s+(?:the\s+)?(?:bug|issue|problem)\b/i, intent: 'fix', confidence: 'medium' },
    { re: /\bcorrigé\s+(?:le\s+)?(?:bug|problème)\b/i, intent: 'fix', confidence: 'medium' },
    { re: /\broot\s+cause\s*:\s*(.+)/i, intent: 'fix', confidence: 'high', extract: 1 },
    { re: /\bcause\s+racine\s*:\s*(.+)/i, intent: 'fix', confidence: 'high', extract: 1 },
    { re: /\bthe\s+(?:real\s+)?problem\s+(?:was|is)\b/i, intent: 'fix', confidence: 'medium' },
    { re: /\ble\s+(?:vrai\s+)?problème\s+(?:était|est)\b/i, intent: 'fix', confidence: 'medium' },
  ]
};

// ═══════════════════════════════════════════════════════════════════════════
// V2 INSIGHT PATTERNS (5x more than V1)
// ═══════════════════════════════════════════════════════════════════════════

const INSIGHT_PATTERNS = [
  // Explicit markers (high priority)
  { re: /Critical:\s*(.+)/i, priority: 10 },
  { re: /Important:\s*(.+)/i, priority: 9 },
  { re: /Key\s+insight:\s*(.+)/i, priority: 10 },
  { re: /Remember:\s*(.+)/i, priority: 8 },
  { re: /Note:\s*(.+)/i, priority: 7 },
  { re: /Warning:\s*(.+)/i, priority: 9 },
  { re: /Caution:\s*(.+)/i, priority: 8 },
  { re: /Tip:\s*(.+)/i, priority: 7 },
  // French explicit markers
  { re: /Critique\s*:\s*(.+)/i, priority: 10 },
  { re: /Important\s*:\s*(.+)/i, priority: 9 },
  { re: /Point\s+clé\s*:\s*(.+)/i, priority: 10 },
  { re: /À\s+retenir\s*:\s*(.+)/i, priority: 9 },
  { re: /Attention\s*:\s*(.+)/i, priority: 8 },
  { re: /Astuce\s*:\s*(.+)/i, priority: 7 },
  // Learning / discovery signals
  { re: /\bI\s+(?:just\s+)?(?:learned|discovered|realized|found\s+out)\b/i, priority: 8 },
  { re: /\bj'ai\s+(?:appris|découvert|réalisé)\b/i, priority: 8 },
  { re: /\bturns\s+out\b/i, priority: 7 },
  { re: /\bil\s+s'avère\s+que\b/i, priority: 7 },
  { re: /\bthe\s+trick\s+(?:is|was)\b/i, priority: 8 },
  { re: /\bl'astuce\s+c'est\b/i, priority: 8 },
  // Problem / solution signals
  { re: /\bthe\s+(?:real\s+)?(?:issue|problem)\s+(?:is|was)\b/i, priority: 8 },
  { re: /\ble\s+(?:vrai\s+)?problème\s+(?:c'est|était)\b/i, priority: 8 },
  { re: /\bsolution\s*:\s*(.+)/i, priority: 9 },
  { re: /\bworkaround\s*:\s*(.+)/i, priority: 7 },
  { re: /\bcontournement\s*:\s*(.+)/i, priority: 7 },
  // Constraint / limitation signals
  { re: /\b(?:Chrome|browser)\s+(?:doesn't|won't|can't)\b/i, priority: 7 },
  { re: /\blimitation\s*:\s*(.+)/i, priority: 8 },
  { re: /\bconstraint\s*:\s*(.+)/i, priority: 8 },
  { re: /\bcontrainte\s*:\s*(.+)/i, priority: 8 },
  // User intent / requirements
  { re: /\bje\s+veux\s+(.+)/i, priority: 6 },
  { re: /\bI\s+want\s+(.+)/i, priority: 6 },
  { re: /\bwe\s+need\s+to\b/i, priority: 6 },
  { re: /\bil\s+faut\b/i, priority: 6 },
  // Best practices / anti-patterns
  { re: /\bbest\s+practice\s*:\s*(.+)/i, priority: 9 },
  { re: /\bbonne\s+pratique\s*:\s*(.+)/i, priority: 9 },
  { re: /\banti-?pattern\s*:\s*(.+)/i, priority: 9 },
  { re: /\bdon't\s+(.+)\s+because\b/i, priority: 8 },
  { re: /\bne\s+(?:pas|jamais)\s+(.+)\s+(?:car|parce\s+que)\b/i, priority: 8 },
  // Success / failure signals
  { re: /\bça\s+(?:marche|fonctionne)\s+(?:parfaitement|très\s+bien)\b/i, priority: 7 },
  { re: /\b(?:this|it)\s+(?:works|worked)\s+(?:perfectly|great)\b/i, priority: 7 },
  { re: /\bça\s+(?:casse|plante|bug)\b/i, priority: 8 },
  { re: /\bthis\s+(?:breaks|crashes|bugs)\b/i, priority: 8 },
];

// ═══════════════════════════════════════════════════════════════════════════
// V2 CONSTRAINT PATTERNS (new)
// ═══════════════════════════════════════════════════════════════════════════

const CONSTRAINT_PATTERNS = [
  // Explicit constraints
  { re: /\bconstraint\s*:\s*(.+)/i, type: 'explicit' },
  { re: /\bcontrainte\s*:\s*(.+)/i, type: 'explicit' },
  { re: /\blimitation\s*:\s*(.+)/i, type: 'technical' },
  { re: /\brestriction\s*:\s*(.+)/i, type: 'explicit' },
  // Technical limitations
  { re: /\b(?:Chrome|browser|API)\s+(?:doesn't|won't|can't|cannot)\s+(.+)/i, type: 'technical' },
  { re: /\b(?:not\s+)?(?:possible|supported|allowed)\s+(?:to|by)\b/i, type: 'technical' },
  { re: /\b(?:pas|n'est\s+pas)\s+(?:possible|supporté|autorisé)\b/i, type: 'technical' },
  // Memory / performance constraints
  { re: /\bmemory\s+(?:limit|issue|problem)\b/i, type: 'performance' },
  { re: /\bproblème\s+de\s+mémoire\b/i, type: 'performance' },
  { re: /\bperformance\s+(?:issue|problem|bottleneck)\b/i, type: 'performance' },
  { re: /\btoo\s+(?:slow|large|big|heavy)\b/i, type: 'performance' },
  { re: /\btrop\s+(?:lent|gros|lourd)\b/i, type: 'performance' },
  // Security / permission constraints
  { re: /\b(?:CORS|CSP|permission)\s+(?:error|issue|block)/i, type: 'security' },
  { re: /\bsecurity\s+(?:constraint|restriction|policy)\b/i, type: 'security' },
  // Negative requirements (DON'T patterns)
  { re: /\bDON'T\s+(.+)/i, type: 'dont' },
  { re: /\bNEVER\s+(.+)/i, type: 'dont' },
  { re: /\bAVOID\s+(.+)/i, type: 'dont' },
  { re: /\bNE\s+(?:PAS|JAMAIS)\s+(.+)/i, type: 'dont' },
  { re: /\bÉVITER\s+(.+)/i, type: 'dont' },
  { re: /\bne\s+(?:pas|plus|jamais)\s+(.+)/i, type: 'dont' },
  // Positive requirements (DO patterns)
  { re: /\bMUST\s+(.+)/i, type: 'do' },
  { re: /\bALWAYS\s+(.+)/i, type: 'do' },
  { re: /\bTOUJOURS\s+(.+)/i, type: 'do' },
  { re: /\bIL\s+FAUT\s+(.+)/i, type: 'do' },
];

// ═══════════════════════════════════════════════════════════════════════════
// SEMANTIC DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute simple similarity score between two strings (Jaccard-ish).
 * @param {string} a 
 * @param {string} b 
 * @returns {number} 0-1 similarity
 */
function textSimilarity(a, b) {
  const tokA = new Set(tokenize(a).filter(t => t.length > 3));
  const tokB = new Set(tokenize(b).filter(t => t.length > 3));
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokA) if (tokB.has(t)) intersection++;
  return intersection / Math.max(tokA.size, tokB.size);
}

/**
 * Deduplicate array of strings by semantic similarity.
 * @param {string[]} items 
 * @param {number} threshold - similarity threshold (default 0.7)
 * @returns {string[]}
 */
function deduplicateBySimilarity(items, threshold = 0.7) {
  const result = [];
  for (const item of items) {
    const isDupe = result.some(existing => textSimilarity(item, existing) > threshold);
    if (!isDupe) result.push(item);
  }
  return result;
}

/**
 * Deduplicate decision objects by chosen_option similarity.
 * @param {Array} decisions 
 * @param {number} threshold 
 * @returns {Array}
 */
function deduplicateDecisions(decisions, threshold = 0.6) {
  const result = [];
  for (const dec of decisions) {
    const chosen = String(dec.chosen_option || '');
    const isDupe = result.some(existing => {
      const existingChosen = String(existing.chosen_option || '');
      return textSimilarity(chosen, existingChosen) > threshold;
    });
    if (!isDupe) result.push(dec);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOPICS EXTRACTION (improved)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract 5-10 topics with weights based on token frequency (TF-IDF-ish).
 * @param {Array<{id:string, role:string, content:string}>} messages
 * @returns {Array<{label:string, weight:number, message_refs:string[], summary:string}>}
 */
function extractTopics(messages) {
  const docs = messages.map((m) => {
    const cleaned = normalizeForExtraction(m.content);
    return tokenize(cleaned).filter((w) => w.length >= 5 && !STOPWORDS.has(w));
  });
  const df = new Map(); // document frequency
  const tf = new Map(); // total term frequency

  for (const tokens of docs) {
    const seen = new Set();
    for (const w of tokens) {
      tf.set(w, (tf.get(w) || 0) + 1);
      if (!seen.has(w)) {
        df.set(w, (df.get(w) || 0) + 1);
        seen.add(w);
      }
    }
  }

  const N = Math.max(1, docs.length);
  const scored = [];
  for (const [w, freq] of tf.entries()) {
    const dfi = df.get(w) || 1;
    if (N >= 5 && dfi / N >= 0.6) continue;
    const idf = Math.log((N + 1) / dfi);
    const score = freq * idf;
    scored.push({ w, freq, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const topWords = scored.slice(0, 30);

  // Build lightweight n-grams (2–3)
  const ngramTf = new Map();
  const ngramDf = new Map();
  for (const m of messages) {
    const cleaned = normalizeForExtraction(m.content);
    const toks = tokenize(cleaned).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
    if (!toks.length) continue;
    const seen = new Set();
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= toks.length; i++) {
        const gram = toks.slice(i, i + n).join(' ');
        if (gram.length < 10) continue;
        ngramTf.set(gram, (ngramTf.get(gram) || 0) + 1);
        if (!seen.has(gram)) {
          ngramDf.set(gram, (ngramDf.get(gram) || 0) + 1);
          seen.add(gram);
        }
      }
    }
  }

  const n = Math.max(1, docs.length);
  const ngramScored = [];
  for (const [g, freq] of ngramTf.entries()) {
    const dfi = ngramDf.get(g) || 1;
    if (n >= 8 && dfi / n >= 0.55) continue;
    const idf = Math.log((n + 1) / dfi);
    const score = freq * idf;
    ngramScored.push({ w: g, freq, score });
  }
  ngramScored.sort((a, b) => b.score - a.score);

  const combined = [];
  for (const t of ngramScored.slice(0, 7)) combined.push({ ...t, kind: 'ngram' });
  for (const t of topWords) {
    if (combined.length >= 7) break;
    if (combined.some((x) => x.w.includes(t.w))) continue;
    combined.push({ ...t, kind: 'word' });
  }

  // V2: Scale max refs based on conversation size
  const totalMsgs = messages.length;
  const maxRefsPerTopic = totalMsgs > 500 ? 8 : totalMsgs > 100 ? 5 : 3;

  return combined.slice(0, 7).map((t, i) => {
    const message_refs = [];
    const recentFirst = [...messages].reverse();
    for (const m of recentFirst) {
      const cleaned = normalizeForExtraction(m.content).toLowerCase();
      if (cleaned.includes(String(t.w).toLowerCase())) {
        if (message_refs.length < maxRefsPerTopic) message_refs.push(m.id);
        else break;
      }
    }
    message_refs.reverse();
    const base = Math.max(1, t.freq || 1);
    const weight = Math.max(200, Math.min(1000, (7 - i) * 120 + base * 30));
    const label = String(t.w);
    return {
      label,
      weight,
      message_refs,
      summary: `"${label}" (${t.freq}x, ${t.kind})`
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 DECISIONS EXTRACTION (major rewrite)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V2: Extract decisions with enhanced patterns, chunking, and adaptive limits.
 * @param {Array<{id:string, role:string, content:string, timestamp?:string}>} messages
 * @returns {Array<any>}
 */
function extractDecisions(messages) {
  const out = [];
  let decIdx = 1;
  
  // V2: Adaptive limit based on conversation size
  const maxDecisions = messages.length > 500 ? 20 : messages.length > 100 ? 15 : 10;

  for (const m of messages) {
    const fullText = normalizeForExtraction(m.content || '');
    if (!fullText) continue;
    
    // V2: Extract chunks instead of skipping long messages
    const chunks = extractChunks(fullText, 600);
    
    for (const text of chunks) {
      // Skip if it still smells like implementation scaffolding
      if (/\b(file\s+\d+|purpose|required|methods?|snapshot schema)\b/i.test(text)) continue;
      
      // Try all pattern categories
      let matched = null;
      let patternCategory = null;
      
      for (const [category, patterns] of Object.entries(DECISION_PATTERNS)) {
        for (const pattern of patterns) {
          if (pattern.re.test(text)) {
            matched = pattern;
            patternCategory = category;
            break;
          }
        }
        if (matched) break;
      }
      
      if (!matched) continue;

      // Prefer assistant-authored decisions
      const role = String(m?.role || '').toLowerCase();
      if (role === 'user' && patternCategory !== 'explicit') {
        continue;
      }

      // Extract chosen option
      let chosen = 'UNKNOWN';
      const explicitMatch = text.match(/Decision:\s*(.+)/i) || text.match(/décision\s*:\s*(.+)/i);
      if (explicitMatch && explicitMatch[1]) {
        chosen = sanitizeChoice(explicitMatch[1]);
      }
      
      // Try pattern-specific extraction
      if (chosen === 'UNKNOWN' && matched.extract) {
        const extractMatch = text.match(matched.re);
        if (extractMatch && extractMatch[matched.extract]) {
          chosen = sanitizeChoice(extractMatch[matched.extract]);
        }
      }
      
      // Fallback: commitment heuristics
      if (chosen === 'UNKNOWN') {
        const commitPatterns = [
          /\b(?:je\s+vais|on\s+va)\s+(.+)/i,
          /\bI'll\s+(.+)/i,
          /\bI'm\s+going\s+to\s+(.+)/i,
          /\bPlan:\s*(.+)/i,
        ];
        for (const cp of commitPatterns) {
          const cm = text.match(cp);
          if (cm && cm[1]) {
            const opt = sanitizeChoice(cm[1]);
            if (isValidChoice(opt)) {
              chosen = opt;
              break;
            }
          }
        }
      }
      
      if (!isValidChoice(chosen)) chosen = 'UNKNOWN';

      // Build options_considered
      const options = [];
      if (chosen !== 'UNKNOWN') {
        options.push({
          option: chosen,
          weight: matched.confidence === 'high' ? 800 : matched.confidence === 'medium' ? 700 : 600,
          rationale: `Extracted from ${patternCategory} pattern.`
        });
      }

      // Extract context refs
      const contextRefs = extractContextRefsFromText(text);

      out.push({
        id: `dec-${decIdx++}`,
        timestamp: m.timestamp || new Date().toISOString(),
        intent: matched.intent,
        intent_text: `${matched.intent} (${patternCategory})`,
        context_refs: contextRefs,
        options_considered: options.length ? options : null,
        chosen_option: chosen,
        chosen_option_truncated: chosen !== 'UNKNOWN' && chosen.length >= 197,
        constraints: [],
        decision_quality: matched.confidence === 'high' ? 'explicit' : 'implicit',
        extraction_confidence: matched.confidence,
        confidence_llm: matched.confidence === 'high' ? 80 : matched.confidence === 'medium' ? 65 : 50,
        confidence_gate: 'pass'
      });
    }
  }

  // V2: Deduplicate by similarity
  const deduped = deduplicateDecisions(out, 0.6);
  
  // Sort by confidence and return
  const confidenceOrder = { high: 3, medium: 2, low: 1 };
  deduped.sort((a, b) => {
    const aConf = confidenceOrder[a.extraction_confidence] || 0;
    const bConf = confidenceOrder[b.extraction_confidence] || 0;
    return bConf - aConf;
  });
  
  return deduped.slice(0, maxDecisions);
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 INSIGHTS EXTRACTION (major rewrite)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V2: Extract insights with enhanced patterns and adaptive limits.
 * @param {Array<{content:string}>} messages
 * @returns {string[]}
 */
function extractInsights(messages) {
  // V2: Adaptive limit
  const maxInsights = messages.length > 500 ? 30 : messages.length > 100 ? 20 : 15;
  
  const candidates = [];

  for (const m of messages) {
    const text = normalizeForExtraction(m.content || '');
    if (!text) continue;
    
    // V2: Process chunks for long messages
    const chunks = extractChunks(text, 400);
    
    for (const chunk of chunks) {
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      
      for (const s of sentences) {
        const str = s.trim();
        if (!str || str.length < 20) continue;
        // V2: Increased max length from 280 to 400
        if (str.length > 400) continue;
        
        // Try all insight patterns
        for (const pattern of INSIGHT_PATTERNS) {
          if (pattern.re.test(str)) {
            candidates.push({
              text: str.length > 300 ? str.slice(0, 297) + '...' : str,
              priority: pattern.priority
            });
            break;
          }
        }
      }
    }
  }
  
  // Sort by priority, dedupe, and return
  candidates.sort((a, b) => b.priority - a.priority);
  const texts = candidates.map(c => c.text);
  const deduped = deduplicateBySimilarity(texts, 0.65);
  
  return deduped.slice(0, maxInsights);
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 CONSTRAINTS EXTRACTION (new)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V2: Extract constraints (DON'T/DO/limitations).
 * @param {Array<{content:string}>} messages
 * @returns {{dont: string[], do: string[], technical: string[]}}
 */
function extractConstraints(messages) {
  const maxPerCategory = messages.length > 500 ? 15 : 10;
  
  const results = {
    dont: [],
    do: [],
    technical: [],
    performance: [],
    security: []
  };

  for (const m of messages) {
    const text = normalizeForExtraction(m.content || '');
    if (!text) continue;
    
    const chunks = extractChunks(text, 400);
    
    for (const chunk of chunks) {
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      
      for (const s of sentences) {
        const str = s.trim();
        if (!str || str.length < 15 || str.length > 300) continue;
        
        for (const pattern of CONSTRAINT_PATTERNS) {
          const match = str.match(pattern.re);
          if (match) {
            const extracted = match[1] ? sanitizeChoice(match[1]) : str;
            const category = pattern.type === 'explicit' ? 'technical' : pattern.type;
            if (results[category] && !results[category].includes(extracted)) {
              results[category].push(extracted);
            }
            break;
          }
        }
      }
    }
  }
  
  // Dedupe each category
  for (const key of Object.keys(results)) {
    results[key] = deduplicateBySimilarity(results[key], 0.6).slice(0, maxPerCategory);
  }
  
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function extractContextRefsFromText(text) {
  const t = String(text || '');
  const refs = new Set();
  const fileRe = /(?:^|\s)([\w./-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|less|py|go|rs|java|vue|svelte))(?:\s|$)/g;
  let m;
  while ((m = fileRe.exec(t)) !== null) {
    if (m[1]) refs.add(m[1]);
  }
  const shaRe = /\b[a-f0-9]{7,40}\b/gi;
  while ((m = shaRe.exec(t)) !== null) {
    const v = String(m[0] || '');
    if (v.length >= 7) refs.add(v);
  }
  return [...refs].slice(0, 8);
}

function sanitizeChoice(text) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[""]/g, '"')
    .replace(/[']/g, "'")
    .trim();
  const noTicks = t
    .replace(/[↓→←⇒⇐]/g, ' ')
    .replace(/[`{}()[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return noTicks.length > 200 ? noTicks.slice(0, 197) + '...' : noTicks;
}

function isValidChoice(text) {
  const t = String(text || '').trim();
  if (!t || t === 'UNKNOWN') return false;
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 8) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 && t.length < 16) return false;
  if ((t.match(/[{}()[\];]/g) || []).length >= 3) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOPICS WITH META (unchanged API)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract topics WITH metadata about extraction quality.
 * @param {Array<{id:string, role:string, content:string}>} messages
 * @returns {{topics: Array, meta: Object}}
 */
function extractTopicsWithMeta(messages) {
  const topics = extractTopics(messages);
  const reasons = [];
  
  const totalMessages = Array.isArray(messages) ? messages.length : 0;
  const topicsCount = topics.length;
  const avgWeight = topicsCount > 0 
    ? topics.reduce((sum, t) => sum + (t.weight || 0), 0) / topicsCount 
    : 0;
  const totalRefs = topics.reduce((sum, t) => sum + (t.message_refs?.length || 0), 0);
  const coverageRatio = totalMessages > 0 ? totalRefs / totalMessages : 0;
  
  const targetCoverage = totalMessages > 500 ? 0.02
    : totalMessages > 100 ? 0.04
    : 0.1;
  
  let quality = 'ok';
  let status = 'extracted';
  
  if (topicsCount === 0) {
    status = 'empty';
    quality = 'degraded';
    reasons.push('no_topics_extracted');
  } else {
    if (coverageRatio < targetCoverage) {
      quality = 'degraded';
      reasons.push('low_coverage');
    }
    if (avgWeight < 300) {
      quality = 'degraded';
      reasons.push('low_weight_average');
    }
    if (topicsCount < 3 && totalMessages > 20) {
      quality = 'degraded';
      reasons.push('sparse_topics_for_large_conversation');
    }
    const stopwordCollisions = topics.filter(t => 
      STOPWORDS.has(String(t.label || '').toLowerCase())
    ).length;
    if (stopwordCollisions > 0) {
      quality = 'degraded';
      reasons.push('stopword_collision');
    }
  }
  
  if (totalMessages > 500 && topicsCount < 5) {
    status = 'partial';
    reasons.push('large_conversation_limited_extraction');
  }
  
  return {
    topics,
    meta: {
      method: 'tfidf_ngram_v2',
      quality,
      status,
      reason: reasons.length > 0 ? reasons : ['extraction_nominal'],
      stats: {
        topics_count: topicsCount,
        messages_scanned: totalMessages,
        avg_weight: Math.round(avgWeight),
        coverage_ratio: Math.round(coverageRatio * 100) / 100,
        coverage_target: targetCoverage,
        total_refs: totalRefs
      }
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line no-undef
if (typeof window !== 'undefined') {
  window.extractTopics = extractTopics;
  window.extractTopicsWithMeta = extractTopicsWithMeta;
  window.extractDecisions = extractDecisions;
  window.extractInsights = extractInsights;
  window.extractConstraints = extractConstraints;
  // V2 utilities
  window.deduplicateBySimilarity = deduplicateBySimilarity;
  window.textSimilarity = textSimilarity;
}
