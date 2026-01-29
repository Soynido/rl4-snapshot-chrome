/**
 * RL4 Progressive Summarizer
 * Generates 3 levels of summaries:
 * - L1 (glance): 1 sentence, max 100 chars
 * - L2 (context): 3-5 sentences, max 500 chars
 * - L3 (detailed): Day-by-day with decisions
 */

/**
 * Truncate text to a maximum length with ellipsis.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(text, maxLen) {
  const t = String(text || '').trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 3) + '...';
}

/**
 * Extract the most important sentence from text.
 * @param {string} text
 * @returns {string}
 */
function extractKeyStatement(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  
  // Split into sentences
  const sentences = t
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 20 && s.length <= 150);
  
  if (sentences.length === 0) return truncate(t, 100);
  
  // Prioritize sentences with decision/action words
  const priorityPatterns = [
    /\b(décid|decided?|implemented?|built|created?|fixed|resolved)\b/i,
    /\b(problem|solution|approach|strategy|goal)\b/i,
    /\b(important|critical|key|main|primary)\b/i
  ];
  
  for (const pattern of priorityPatterns) {
    const match = sentences.find(s => pattern.test(s));
    if (match) return truncate(match, 100);
  }
  
  return truncate(sentences[0], 100);
}

/**
 * Generate L1 summary (glance): 1 sentence, max 100 chars.
 * @param {Object} params
 * @param {string} [params.contextSummary]
 * @param {Array} [params.topics]
 * @param {Array} [params.decisions]
 * @param {Object} [params.contextState]
 * @returns {string}
 */
function generateL1Summary(params = {}) {
  const contextSummary = String(params.contextSummary || '').trim();
  const topics = Array.isArray(params.topics) ? params.topics : [];
  const decisions = Array.isArray(params.decisions) ? params.decisions : [];
  const contextState = params.contextState || {};
  
  // Try to extract from context summary first
  if (contextSummary) {
    const statement = extractKeyStatement(contextSummary);
    if (statement) return statement;
  }
  
  // Try context state goal
  const goal = String(contextState.current_goal || '').trim();
  if (goal && goal.length >= 20) {
    return truncate(goal, 100);
  }
  
  // Build from topics + decisions
  const topicLabels = topics.slice(0, 3).map(t => t?.label).filter(Boolean);
  const decisionIntents = decisions.slice(0, 2).map(d => d?.intent).filter(Boolean);
  
  if (topicLabels.length > 0) {
    const base = `Focus: ${topicLabels.join(', ')}`;
    if (decisionIntents.length > 0) {
      return truncate(`${base}. Actions: ${decisionIntents.join(', ')}.`, 100);
    }
    return truncate(base + '.', 100);
  }
  
  return 'Context captured.';
}

/**
 * Generate L2 summary (context): 3-5 sentences, max 500 chars.
 * @param {Object} params
 * @param {string} [params.contextSummary]
 * @param {Array} [params.topics]
 * @param {Array} [params.decisions]
 * @param {Array} [params.insights]
 * @param {Object} [params.contextState]
 * @param {Object} [params.metadata]
 * @returns {string}
 */
function generateL2Summary(params = {}) {
  const contextSummary = String(params.contextSummary || '').trim();
  const topics = Array.isArray(params.topics) ? params.topics : [];
  const decisions = Array.isArray(params.decisions) ? params.decisions : [];
  const insights = Array.isArray(params.insights) ? params.insights : [];
  const contextState = params.contextState || {};
  const metadata = params.metadata || {};
  
  const parts = [];
  
  // Opening: what is this about
  const subject = String(contextState.core_subject || 'Development session').trim();
  const goal = String(contextState.current_goal || '').trim();
  if (goal) {
    parts.push(`${subject}: ${truncate(goal, 80)}.`);
  } else {
    parts.push(`${subject}.`);
  }
  
  // Topics covered
  const topicLabels = topics.slice(0, 5).map(t => t?.label).filter(Boolean);
  if (topicLabels.length > 0) {
    parts.push(`Topics: ${topicLabels.join(', ')}.`);
  }
  
  // Key decisions
  const keyDecisions = decisions
    .filter(d => d && (d.decision_quality === 'explicit' || d.confidence_llm > 70))
    .slice(0, 3);
  
  if (keyDecisions.length > 0) {
    const decisionTexts = keyDecisions.map(d => {
      const intent = String(d.intent || '').trim();
      const choice = truncate(d.chosen_option || '', 60);
      return intent ? `${intent}: ${choice}` : choice;
    });
    parts.push(`Decisions: ${decisionTexts.join('; ')}.`);
  }
  
  // Key insight if available
  if (insights.length > 0) {
    const firstInsight = typeof insights[0] === 'string' 
      ? insights[0] 
      : String(insights[0]?.text || '');
    if (firstInsight) {
      parts.push(`Note: ${truncate(firstInsight, 80)}.`);
    }
  }
  
  // Metadata
  const msgCount = metadata.messages || metadata.total_messages || 0;
  if (msgCount > 0) {
    parts.push(`(${msgCount} messages captured)`);
  }
  
  return truncate(parts.join(' '), 500);
}

/**
 * Generate L3 summary (detailed): Day-by-day with decisions.
 * @param {Object} params
 * @param {Array} [params.cognitiveDays] - From cognitive-splitter
 * @param {Array} [params.decisions]
 * @param {Array} [params.topics]
 * @param {Array} [params.timelineMacro]
 * @param {string} [params.contextSummary]
 * @returns {Array<{day:string, focus:string, decisions:string[], summary:string}>}
 */
function generateL3Summary(params = {}) {
  const cognitiveDays = Array.isArray(params.cognitiveDays) ? params.cognitiveDays : [];
  const decisions = Array.isArray(params.decisions) ? params.decisions : [];
  const topics = Array.isArray(params.topics) ? params.topics : [];
  const timelineMacro = Array.isArray(params.timelineMacro) ? params.timelineMacro : [];
  
  // If we have cognitive days, use them
  if (cognitiveDays.length > 0) {
    return cognitiveDays.map(day => ({
      day: day.day_id,
      focus: day.focus || 'general',
      key_shift: day.key_shift || 'continuation',
      decisions: day.decisions_in_scope || [],
      summary: `Messages ${day.messages_range.start + 1}-${day.messages_range.end + 1}: ${day.focus}`
    }));
  }
  
  // Fallback: use timeline_macro if available
  if (timelineMacro.length > 0) {
    return timelineMacro.map((phase, i) => {
      // Find decisions that might belong to this phase
      const phaseDecisions = decisions
        .slice(Math.floor(i * decisions.length / timelineMacro.length), 
               Math.floor((i + 1) * decisions.length / timelineMacro.length))
        .map(d => truncate(d.chosen_option || d.intent || '', 80));
      
      return {
        day: phase.phase || `Phase ${i + 1}`,
        focus: extractFocusFromSummary(phase.summary),
        key_shift: i === 0 ? 'initial' : 'continuation',
        decisions: phaseDecisions,
        summary: phase.summary || ''
      };
    });
  }
  
  // Final fallback: single entry
  const topicLabels = topics.slice(0, 5).map(t => t?.label).filter(Boolean);
  const allDecisions = decisions.slice(0, 5).map(d => 
    truncate(d.chosen_option || d.intent || '', 80)
  );
  
  return [{
    day: 'day-1',
    focus: topicLabels.join(', ') || 'general',
    key_shift: 'initial',
    decisions: allDecisions,
    summary: params.contextSummary || ''
  }];
}

/**
 * Extract focus topic from a summary string.
 * @param {string} summary
 * @returns {string}
 */
function extractFocusFromSummary(summary) {
  const t = String(summary || '').trim();
  if (!t) return 'general';
  
  // Try to extract keywords from summary
  const keywordsMatch = t.match(/Keywords:\s*([^•|]+)/i);
  if (keywordsMatch && keywordsMatch[1]) {
    return keywordsMatch[1].trim();
  }
  
  // Extract first meaningful words
  const words = t
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4)
    .slice(0, 3);
  
  return words.join(', ') || 'general';
}

/**
 * Build progressive summary with all 3 levels.
 * @param {Object} params
 * @param {string} [params.contextSummary]
 * @param {Array} [params.topics]
 * @param {Array} [params.decisions]
 * @param {Array} [params.insights]
 * @param {Object} [params.contextState]
 * @param {Object} [params.metadata]
 * @param {Array} [params.cognitiveDays]
 * @param {Array} [params.timelineMacro]
 * @returns {{L1:string, L2:string, L3:Array}}
 */
function buildProgressiveSummary(params = {}) {
  return {
    L1: generateL1Summary(params),
    L2: generateL2Summary(params),
    L3: generateL3Summary(params)
  };
}

// Export for browser and Node.js
if (typeof window !== 'undefined') {
  window.buildProgressiveSummary = buildProgressiveSummary;
  window.generateL1Summary = generateL1Summary;
  window.generateL2Summary = generateL2Summary;
  window.generateL3Summary = generateL3Summary;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { 
    buildProgressiveSummary, 
    generateL1Summary, 
    generateL2Summary, 
    generateL3Summary,
    truncate
  };
}
