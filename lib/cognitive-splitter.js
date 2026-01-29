/**
 * RL4 Cognitive Splitter
 * Splits conversation messages into "cognitive days" based on thematic pivots.
 * Uses Jaccard similarity to detect topic shifts.
 */

/**
 * Tokenize text into normalized words for similarity comparison.
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  const t = String(text || '').toLowerCase();
  // Remove code blocks and URLs
  const cleaned = t
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const tokens = cleaned.split(/\s+/).filter(w => w.length >= 4);
  return new Set(tokens);
}

/**
 * Calculate Jaccard similarity between two token sets.
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number} - Similarity score between 0 and 1
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Extract dominant topics from a message slice.
 * @param {Array<{content:string}>} messages
 * @param {number} limit
 * @returns {string[]}
 */
function extractDominantTopics(messages, limit = 3) {
  const counts = new Map();
  const STOP = new Set([
    'this', 'that', 'with', 'from', 'have', 'will', 'your', 'you', 'and', 'for',
    'are', 'was', 'were', 'into', 'about', 'then', 'what', 'when', 'where', 'which',
    'who', 'why', 'how', 'can', 'could', 'should', 'would', 'also', 'just', 'like',
    'make', 'some', 'more', 'most', 'very', 'only', 'does', 'done', 'been',
    'avec', 'pour', 'dans', 'comme', 'plus', 'moins', 'aussi', 'mais', 'donc', 'alors',
    'function', 'const', 'return', 'async', 'await', 'class', 'export', 'import'
  ]);
  
  for (const m of messages) {
    const tokens = tokenize(m?.content || '');
    for (const token of tokens) {
      if (STOP.has(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * Detect decisions mentioned in a message slice.
 * @param {Array<{content:string}>} messages
 * @returns {string[]}
 */
function extractDecisionsInScope(messages) {
  const decisionPatterns = [
    /\b(décid[éeons]|decided?|choosing?|chose|picked?|selected?)\s+(.{10,60})/gi,
    /\b(on va|we'll|let's|going to)\s+(.{10,60})/gi,
    /\b(solution|approach|strategy)\s*:\s*(.{10,60})/gi
  ];
  
  const decisions = [];
  for (const m of messages) {
    const text = String(m?.content || '');
    for (const pattern of decisionPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const decision = (match[2] || '').trim();
        if (decision && decision.length >= 10 && decision.length <= 80) {
          decisions.push(decision.replace(/[.!?,;:]+$/, ''));
          if (decisions.length >= 5) break;
        }
      }
      if (decisions.length >= 5) break;
    }
    if (decisions.length >= 5) break;
  }
  
  return [...new Set(decisions)].slice(0, 5);
}

/**
 * Split messages into cognitive days based on thematic pivots.
 * @param {Array<{id:string, role:string, content:string, timestamp?:string}>} messages
 * @param {Object} options
 * @param {number} [options.similarityThreshold=0.25] - Jaccard threshold for pivot detection
 * @param {number} [options.windowSize=5] - Messages to compare for similarity
 * @param {number} [options.minDaySize=3] - Minimum messages per cognitive day
 * @param {number} [options.maxDays=10] - Maximum cognitive days to generate
 * @returns {Array<{day_id:string, focus:string, key_shift:string, decisions_in_scope:string[], messages_range:{start:number, end:number}}>}
 */
function splitIntoCognitiveDays(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const n = list.length;
  if (n === 0) return [];
  
  const {
    similarityThreshold = 0.25,
    windowSize = 5,
    minDaySize = 3,
    maxDays = 10
  } = options;
  
  // For very short conversations, return a single day
  if (n <= minDaySize * 2) {
    return [{
      day_id: 'day-1',
      focus: extractDominantTopics(list, 3).join(', ') || 'general',
      key_shift: 'initial',
      decisions_in_scope: extractDecisionsInScope(list),
      messages_range: { start: 0, end: n - 1 }
    }];
  }
  
  // Detect pivot points based on Jaccard similarity drop
  const pivotIndices = [0]; // Always start with index 0
  
  for (let i = windowSize; i < n - windowSize; i++) {
    const beforeSlice = list.slice(Math.max(0, i - windowSize), i);
    const afterSlice = list.slice(i, Math.min(n, i + windowSize));
    
    // Tokenize content from each window
    let beforeTokens = new Set();
    let afterTokens = new Set();
    
    for (const m of beforeSlice) {
      for (const token of tokenize(m?.content || '')) {
        beforeTokens.add(token);
      }
    }
    
    for (const m of afterSlice) {
      for (const token of tokenize(m?.content || '')) {
        afterTokens.add(token);
      }
    }
    
    const similarity = jaccardSimilarity(beforeTokens, afterTokens);
    
    // Low similarity = thematic pivot
    if (similarity < similarityThreshold) {
      // Ensure minimum distance from last pivot
      const lastPivot = pivotIndices[pivotIndices.length - 1];
      if (i - lastPivot >= minDaySize) {
        pivotIndices.push(i);
      }
    }
  }
  
  // Build cognitive days from pivot points
  const days = [];
  
  for (let i = 0; i < pivotIndices.length && days.length < maxDays; i++) {
    const startIdx = pivotIndices[i];
    const endIdx = i < pivotIndices.length - 1 
      ? pivotIndices[i + 1] - 1 
      : n - 1;
    
    const dayMessages = list.slice(startIdx, endIdx + 1);
    if (dayMessages.length < minDaySize && i > 0) continue;
    
    const focus = extractDominantTopics(dayMessages, 3).join(', ') || 'general';
    
    // Determine the key shift (what changed from previous day)
    let keyShift = 'initial';
    if (i > 0) {
      const prevDayMessages = list.slice(pivotIndices[i - 1], startIdx);
      const prevTopics = extractDominantTopics(prevDayMessages, 2);
      const currTopics = extractDominantTopics(dayMessages, 2);
      
      const newTopics = currTopics.filter(t => !prevTopics.includes(t));
      keyShift = newTopics.length > 0 
        ? `shift to ${newTopics.join(', ')}` 
        : 'continuation with refinement';
    }
    
    days.push({
      day_id: `day-${days.length + 1}`,
      focus,
      key_shift: keyShift,
      decisions_in_scope: extractDecisionsInScope(dayMessages),
      messages_range: { start: startIdx, end: endIdx }
    });
  }
  
  // If we didn't create enough days, merge small ones or create uniform splits
  if (days.length === 0) {
    const chunkSize = Math.ceil(n / Math.min(maxDays, Math.ceil(n / minDaySize)));
    for (let i = 0; i < n && days.length < maxDays; i += chunkSize) {
      const endIdx = Math.min(n - 1, i + chunkSize - 1);
      const dayMessages = list.slice(i, endIdx + 1);
      
      days.push({
        day_id: `day-${days.length + 1}`,
        focus: extractDominantTopics(dayMessages, 3).join(', ') || 'general',
        key_shift: days.length === 0 ? 'initial' : 'continuation',
        decisions_in_scope: extractDecisionsInScope(dayMessages),
        messages_range: { start: i, end: endIdx }
      });
    }
  }
  
  return days;
}

// Export for browser and Node.js
if (typeof window !== 'undefined') {
  window.splitIntoCognitiveDays = splitIntoCognitiveDays;
  window.jaccardSimilarity = jaccardSimilarity;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { splitIntoCognitiveDays, jaccardSimilarity, tokenize };
}
