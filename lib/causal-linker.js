/**
 * RL4 Causal Linker
 * Builds causal chains: trigger → decision → implementation → outcome
 * Calculates impact scores for each chain.
 */

/**
 * Normalize text for matching.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract keywords from text for correlation.
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
function extractKeywords(text, limit = 5) {
  const t = normalizeText(text);
  const STOP = new Set([
    'this', 'that', 'with', 'from', 'have', 'will', 'your', 'you', 'and', 'for',
    'are', 'the', 'was', 'were', 'into', 'about', 'then', 'what', 'when', 'where',
    'avec', 'pour', 'dans', 'comme', 'plus', 'moins', 'aussi', 'mais', 'donc'
  ]);
  
  const words = t
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP.has(w));
  
  // Count frequencies
  const counts = new Map();
  for (const w of words) {
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

/**
 * Calculate semantic overlap between two texts.
 * @param {string} textA
 * @param {string} textB
 * @returns {number} - Score between 0 and 1
 */
function semanticOverlap(textA, textB) {
  const keywordsA = new Set(extractKeywords(textA, 10));
  const keywordsB = new Set(extractKeywords(textB, 10));
  
  if (keywordsA.size === 0 || keywordsB.size === 0) return 0;
  
  let overlap = 0;
  for (const k of keywordsA) {
    if (keywordsB.has(k)) overlap++;
  }
  
  return overlap / Math.max(keywordsA.size, keywordsB.size);
}

/**
 * Find the trigger (problem/question) that led to a decision.
 * @param {Object} decision
 * @param {Array} evidence - Evidence pack with file events, chat refs, etc.
 * @param {Array} insights
 * @returns {Object|null}
 */
function findTrigger(decision, evidence, insights) {
  const decisionText = String(decision?.chosen_option || decision?.intent_text || '');
  if (!decisionText) return null;
  
  // Look for related insights that might be triggers
  const relatedInsights = (insights || []).filter(insight => {
    const insightText = typeof insight === 'string' ? insight : String(insight?.text || '');
    return semanticOverlap(decisionText, insightText) > 0.2;
  });
  
  if (relatedInsights.length > 0) {
    const insight = relatedInsights[0];
    return {
      type: 'insight',
      text: typeof insight === 'string' ? insight : String(insight?.text || ''),
      confidence: 0.7
    };
  }
  
  // Look for evidence that might be a trigger
  const fileEvents = Array.isArray(evidence?.recent_file_events) ? evidence.recent_file_events : [];
  const relatedEvents = fileEvents.filter(e => {
    const path = String(e?.path || e?.to || '');
    return decisionText.toLowerCase().includes(path.split('/').pop().split('.')[0].toLowerCase());
  });
  
  if (relatedEvents.length > 0) {
    return {
      type: 'file_event',
      text: `File activity on ${relatedEvents[0].path || relatedEvents[0].to}`,
      confidence: 0.5
    };
  }
  
  // Default trigger based on decision intent
  const intent = String(decision?.intent || 'unknown');
  return {
    type: 'implicit',
    text: `Question about ${intent}`,
    confidence: 0.3
  };
}

/**
 * Find implementation evidence for a decision.
 * @param {Object} decision
 * @param {Object} evidence
 * @returns {Object|null}
 */
function findImplementation(decision, evidence) {
  const decisionText = String(decision?.chosen_option || '');
  if (!decisionText) return null;
  
  const fileEvents = Array.isArray(evidence?.recent_file_events) ? evidence.recent_file_events : [];
  
  // Look for file modifications that match the decision
  const implementations = [];
  for (const event of fileEvents) {
    const type = String(event?.type || '');
    const path = String(event?.path || event?.to || '');
    
    if (type === 'change' || type === 'create') {
      // Check if the file is mentioned in the decision
      const fileName = path.split('/').pop();
      if (decisionText.toLowerCase().includes(fileName.toLowerCase().split('.')[0])) {
        implementations.push({
          type: 'file_change',
          file: path,
          action: type,
          confidence: 0.8
        });
      }
    }
  }
  
  if (implementations.length > 0) {
    return implementations[0];
  }
  
  // Implicit implementation (decision without tracked changes)
  return {
    type: 'implicit',
    text: 'Implementation details not tracked',
    confidence: 0.2
  };
}

/**
 * Infer outcome from a decision and its implementation.
 * @param {Object} decision
 * @param {Object} implementation
 * @param {Array} insights
 * @returns {Object}
 */
function inferOutcome(decision, implementation, insights) {
  const decisionQuality = String(decision?.decision_quality || 'unknown');
  const confidence = typeof decision?.confidence_llm === 'number' ? decision.confidence_llm : 50;
  
  // High confidence decisions with implementations are likely successful
  if (confidence > 70 && implementation && implementation.type !== 'implicit') {
    return {
      type: 'success',
      text: 'Decision implemented',
      confidence: 0.7
    };
  }
  
  // Look for insights that suggest success or failure
  const successPatterns = /(?:worked|success|fixed|resolved|completed|done)/i;
  const failurePatterns = /(?:failed|error|bug|issue|problem|broken)/i;
  
  for (const insight of insights || []) {
    const text = typeof insight === 'string' ? insight : String(insight?.text || '');
    if (successPatterns.test(text)) {
      return { type: 'success', text, confidence: 0.6 };
    }
    if (failurePatterns.test(text)) {
      return { type: 'failure', text, confidence: 0.6 };
    }
  }
  
  return {
    type: 'pending',
    text: 'Outcome not yet determined',
    confidence: 0.3
  };
}

/**
 * Calculate impact score for a causal chain.
 * @param {Object} chain
 * @returns {number} - Score between 0 and 1
 */
function calculateImpactScore(chain) {
  if (!chain) return 0;
  
  let score = 0;
  let factors = 0;
  
  // Trigger confidence
  if (chain.trigger?.confidence) {
    score += chain.trigger.confidence * 0.2;
    factors += 0.2;
  }
  
  // Decision quality
  if (chain.decision) {
    const quality = String(chain.decision.decision_quality || '');
    const qualityScore = quality === 'explicit' ? 1 : quality === 'strong' ? 0.8 : 0.5;
    score += qualityScore * 0.3;
    factors += 0.3;
  }
  
  // Implementation confidence
  if (chain.implementation?.confidence) {
    score += chain.implementation.confidence * 0.25;
    factors += 0.25;
  }
  
  // Outcome type
  if (chain.outcome) {
    const outcomeScore = 
      chain.outcome.type === 'success' ? 1 :
      chain.outcome.type === 'pending' ? 0.5 :
      chain.outcome.type === 'failure' ? 0.3 : 0.4;
    score += outcomeScore * chain.outcome.confidence * 0.25;
    factors += 0.25;
  }
  
  return factors > 0 ? Math.round((score / factors) * 100) / 100 : 0;
}

/**
 * Build causal chains from decisions, evidence, and insights.
 * @param {Array} decisions - Array of decision objects
 * @param {Object} evidence - Evidence pack with file events, chat refs, etc.
 * @param {Array} insights - Array of insights
 * @param {Object} options
 * @param {number} [options.maxChains=10] - Maximum chains to build
 * @param {number} [options.minImpactScore=0.3] - Minimum impact score to include
 * @returns {Array<{chain_id:string, trigger:Object, decision:Object, implementation:Object, outcome:Object, impact_score:number}>}
 */
function buildCausalChains(decisions, evidence, insights, options = {}) {
  const decisionList = Array.isArray(decisions) ? decisions : [];
  const insightList = Array.isArray(insights) ? insights : [];
  const evidencePack = evidence && typeof evidence === 'object' ? evidence : {};
  
  const {
    maxChains = 10,
    minImpactScore = 0.3
  } = options;
  
  if (decisionList.length === 0) return [];
  
  const chains = [];
  
  for (const decision of decisionList) {
    if (chains.length >= maxChains) break;
    
    const trigger = findTrigger(decision, evidencePack, insightList);
    const implementation = findImplementation(decision, evidencePack);
    const outcome = inferOutcome(decision, implementation, insightList);
    
    const chain = {
      chain_id: `chain-${chains.length + 1}`,
      trigger,
      decision: {
        id: decision.id,
        intent: decision.intent,
        chosen_option: decision.chosen_option,
        decision_quality: decision.decision_quality,
        confidence_llm: decision.confidence_llm
      },
      implementation,
      outcome,
      impact_score: 0
    };
    
    chain.impact_score = calculateImpactScore(chain);
    
    // Filter by minimum impact score
    if (chain.impact_score >= minImpactScore) {
      chains.push(chain);
    }
  }
  
  // Sort by impact score descending
  chains.sort((a, b) => b.impact_score - a.impact_score);
  
  return chains.slice(0, maxChains);
}

// Export for browser and Node.js
if (typeof window !== 'undefined') {
  window.buildCausalChains = buildCausalChains;
  window.calculateImpactScore = calculateImpactScore;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { 
    buildCausalChains, 
    calculateImpactScore,
    findTrigger,
    findImplementation,
    inferOutcome
  };
}
