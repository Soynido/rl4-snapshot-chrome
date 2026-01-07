/**
 * RL4 Forensic Scraper - Script de scraping complet pour extraire toute la conversation
 * 
 * UTILISATION:
 * 1. Ouvre la page partagée Claude.ai (ex: https://claude.ai/share/...)
 * 2. Ouvre la Console DevTools (F12)
 * 3. Colle ce script entier dans la console
 * 4. Appuie sur Entrée
 * 5. Le JSON complet sera copié dans ton presse-papier
 */

(async function() {
  console.log('[RL4] 🔍 Forensic Scraper démarré...');
  
  const shareId = window.location.pathname.split('/')[2] || '';
  const isShare = window.location.pathname.startsWith('/share/');
  
  console.log('[RL4] Share ID:', shareId);
  console.log('[RL4] Is Share Page:', isShare);
  
  let messages = [];
  let jsonData = null;
  let successfulEndpoint = null;
  
  // Méthode 1: Fetch direct de l'API (MEILLEURE MÉTHODE)
  if (isShare && shareId) {
    const endpoints = [
      `/api/chat_snapshots/${shareId}?rendering_mode=messages&render_all_tools=true`,
      `/api/chat_snapshots/${shareId}?rendering_mode=messages`,
      `/api/chat_snapshots/${shareId}`,
      `/api/shares/${shareId}`,
      `/backend-api/chat_snapshots/${shareId}`,
      `/api/conversations/${shareId}`,
      `/api/chat/${shareId}`
    ];
    
    for (const endpoint of endpoints) {
      try {
        console.log('[RL4] 🔄 Tentative:', endpoint);
        
        // Essayer avec credentials
        let res = await fetch(endpoint, { 
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        
        if (!res.ok) {
          // Essayer sans credentials
          res = await fetch(endpoint, { 
            credentials: 'omit',
            headers: { 'Accept': 'application/json' }
          });
        }
        
        if (res.ok) {
          jsonData = await res.json();
          successfulEndpoint = endpoint;
          console.log('[RL4] ✅ Succès! Structure:', Object.keys(jsonData));
          console.log('[RL4] 📊 Taille JSON:', JSON.stringify(jsonData).length, 'caractères');
          
          // Extraction agressive récursive
          const extractMessages = (obj, depth = 0, path = '') => {
            if (depth > 10) return [];
            const found = [];
            
            // Si c'est un array, chercher des objets message-like
            if (Array.isArray(obj)) {
              for (let i = 0; i < obj.length; i++) {
                const item = obj[i];
                if (!item || typeof item !== 'object') continue;
                
                // Détecter un message
                const role = String(item.role || item.sender || item.type || '').toLowerCase();
                let content = '';
                
                // Claude.ai format: content peut être array de blocks { type: "text", text: "..." }
                if (Array.isArray(item.content)) {
                  content = item.content
                    .map(block => {
                      if (typeof block === 'string') return block;
                      if (block && typeof block === 'object') {
                        if (typeof block.text === 'string') return block.text;
                        if (block.type === 'text' && typeof block.text === 'string') return block.text;
                        if (typeof block.content === 'string') return block.content;
                      }
                      return '';
                    })
                    .filter(Boolean)
                    .join('\n');
                } else if (typeof item.content === 'string') {
                  content = item.content;
                } else if (item.text) {
                  content = item.text;
                } else if (item.message) {
                  content = typeof item.message === 'string' ? item.message : JSON.stringify(item.message);
                }
                
                // Normaliser le role
                let normalizedRole = null;
                if (role === 'user' || role === 'human') normalizedRole = 'user';
                else if (role === 'assistant' || role === 'claude' || role === 'ai') normalizedRole = 'assistant';
                
                // Si on a un role valide et du contenu, c'est un message
                if (normalizedRole && content && content.trim().length > 0) {
                  found.push({
                    role: normalizedRole,
                    content: content.trim(),
                    timestamp: item.timestamp || item.created_at || item.createdAt || null,
                    source_path: `${path}[${i}]`
                  });
                }
                
                // Continuer la récursion
                found.push(...extractMessages(item, depth + 1, `${path}[${i}]`));
              }
            } 
            // Si c'est un objet, chercher des clés communes
            else if (typeof obj === 'object' && obj !== null) {
              // Clés prioritaires (structures Claude.ai communes)
              const priorityKeys = ['messages', 'chat_messages', 'conversation', 'items', 'chat', 'data', 'content'];
              
              for (const key of priorityKeys) {
                if (obj[key] && Array.isArray(obj[key])) {
                  console.log(`[RL4] 📦 Trouvé structure: ${key} (${obj[key].length} items)`);
                  found.push(...extractMessages(obj[key], depth + 1, `${path}.${key}`));
                }
              }
              
              // Parcourir toutes les clés pour trouver des arrays cachés
              for (const [k, v] of Object.entries(obj)) {
                if (priorityKeys.includes(k)) continue; // déjà traité
                if (Array.isArray(v)) {
                  found.push(...extractMessages(v, depth + 1, `${path}.${k}`));
                } else if (v && typeof v === 'object') {
                  found.push(...extractMessages(v, depth + 1, `${path}.${k}`));
                }
              }
            }
            
            return found;
          };
          
          messages = extractMessages(jsonData);
          
          // Dédupliquer par contenu
          const seen = new Set();
          const unique = [];
          for (const msg of messages) {
            const sig = `${msg.role}|${msg.content.slice(0, 200).toLowerCase()}`;
            if (!seen.has(sig)) {
              seen.add(sig);
              unique.push(msg);
            }
          }
          messages = unique;
          
          console.log('[RL4] 📨 Messages extraits:', messages.length);
          if (messages.length > 0) break;
        } else {
          console.log('[RL4] ❌ Échec:', endpoint, `(${res.status} ${res.statusText})`);
        }
      } catch (e) {
        console.log('[RL4] ❌ Erreur:', endpoint, e.message);
      }
    }
  }
  
  // Méthode 2: DOM scraping si API échoue
  if (messages.length === 0) {
    console.log('[RL4] ⚠️ API échouée, fallback: DOM scraping...');
    
    // Scroll pour charger tout le contenu
    const originalScroll = window.scrollY;
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 500));
    
    const selectors = [
      '[data-testid*="message"]',
      '.font-user-message',
      '.font-claude-message',
      '[data-is-user-message]',
      '[data-is-user-message="true"]',
      '[data-is-user-message="false"]',
      '.message',
      '[class*="message"]'
    ];
    
    const nodes = [];
    for (const sel of selectors) {
      const found = Array.from(document.querySelectorAll(sel));
      nodes.push(...found);
    }
    
    console.log('[RL4] 📄 Nodes DOM trouvés:', nodes.length);
    
    for (const node of nodes) {
      const text = (node.innerText || node.textContent || '').trim();
      if (!text || text.length < 5) continue;
      
      let role = null;
      if (node.matches?.('.font-user-message, [data-is-user-message="true"]')) {
        role = 'user';
      } else if (node.matches?.('.font-claude-message, [data-is-user-message="false"]')) {
        role = 'assistant';
      } else {
        // Heuristique: chercher dans les attributs
        const aria = node.getAttribute?.('aria-label') || '';
        if (/user|human/i.test(aria)) role = 'user';
        else if (/assistant|claude|ai/i.test(aria)) role = 'assistant';
      }
      
      if (role) {
        messages.push({ role, content: text });
      }
    }
    
    // Restaurer scroll
    window.scrollTo(0, originalScroll);
  }
  
  // Méthode 3: IndexedDB / LocalStorage (dernier recours)
  if (messages.length === 0) {
    console.log('[RL4] ⚠️ DOM échoué, tentative IndexedDB/LocalStorage...');
    
    try {
      // Chercher dans localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.includes('conversation') || key.includes('chat') || key.includes('message'))) {
          try {
            const val = JSON.parse(localStorage.getItem(key));
            if (val && typeof val === 'object') {
              const extracted = extractMessages(val);
              if (extracted.length > 0) {
                messages.push(...extracted);
                console.log('[RL4] ✅ Messages trouvés dans localStorage:', key);
              }
            }
          } catch (_) {}
        }
      }
    } catch (e) {
      console.log('[RL4] ❌ Erreur localStorage:', e.message);
    }
  }
  
  // Format final
  const output = {
    share_id: shareId,
    url: window.location.href,
    extracted_at: new Date().toISOString(),
    extraction_method: successfulEndpoint ? 'api' : (messages.length > 0 ? 'dom' : 'failed'),
    successful_endpoint: successfulEndpoint || null,
    total_messages: messages.length,
    messages: messages.map((m, i) => ({
      id: `msg-${i + 1}`,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || new Date().toISOString()
    })),
    raw_json_structure: jsonData ? Object.keys(jsonData) : null,
    debug_info: {
      pathname: window.location.pathname,
      is_share: isShare,
      dom_nodes_found: document.querySelectorAll('[data-testid*="message"]').length
    }
  };
  
  console.log('[RL4] ✅ Extraction complète!');
  console.log('[RL4] 📊 Résumé:', {
    total: output.total_messages,
    method: output.extraction_method,
    endpoint: output.successful_endpoint
  });
  
  // Afficher un échantillon
  if (output.messages.length > 0) {
    console.log('[RL4] 📝 Premier message:', output.messages[0].content.substring(0, 100) + '...');
    console.log('[RL4] 📝 Dernier message:', output.messages[output.messages.length - 1].content.substring(0, 100) + '...');
  }
  
  console.log('[RL4] 📋 Copie dans le presse-papier...');
  
  // Copier dans le presse-papier
  const jsonStr = JSON.stringify(output, null, 2);
  try {
    await navigator.clipboard.writeText(jsonStr);
    console.log('[RL4] ✅ ✅ ✅ COPIÉ DANS LE PRESSE-PAPIER! ✅ ✅ ✅');
    console.log('[RL4] Colle-le dans un fichier JSON ou envoie-le moi.');
  } catch (e) {
    console.log('[RL4] ⚠️ Impossible de copier automatiquement. Copie manuellement:');
    console.log(jsonStr);
  }
  
  return output;
})();
