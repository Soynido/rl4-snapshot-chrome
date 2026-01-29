# RAPPORT ARCHITECTURALE EXHAUSTIF — RL4 SNAPSHOT EXTENSION (CHROME)

**Date de génération** : 2026-01-20  
**Version analysée** : `rl4-snapshot-extension` (implémentation Chrome MV3)  
**Auteur** : Analyse forensique complète

---

## PARTIE 1 : VUE D'ENSEMBLE

### 1.1 Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    EXTENSION UI LAYER                       │
│  popup.html + popup.js + popup.css                           │
│  - Wizard 4 étapes (generate → encode → finalize → copy)     │
│  - UI "side panel" + in‑page widget (iframe popup.html)      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    CAPTURE LAYER                            │
│  content.js                                                   │
│  - Capture DOM (Claude/ChatGPT/Gemini/Perplexity/Copilot)     │
│  - API interception via page-context injection               │
│  - Hydration pour historiques virtualisés (Gemini)           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    COMPRESSION LAYER                        │
│  lib/extraction.js                                            │
│  - topics (TF‑IDF‑ish), decisions, insights                   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    SNAPSHOT LAYER                           │
│  lib/snapshot.js                                              │
│  - RCEP_v1 Digest / RCEP_v2 Ultra / UltraPlus                 │
│  - timeline_summary / timeline_macro                          │
│  - fingerprint transcript (SHA‑256)                           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    INTEGRITY LAYER                          │
│  lib/checksum.js + device-only signature                      │
│  - canonicalize + SHA‑256 checksum                            │
│  - Integrity Seal (ECDSA P‑256, IndexedDB)                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    OUTPUT LAYER                             │
│  popup.js                                                     │
│  - Prompt de handoff (JSON)                                   │
│  - RL4 Blocks encoder prompt + finalize                       │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Data Flow Global

```
USER ouvre une conversation (Claude/ChatGPT/Gemini/Perplexity/Copilot)
    ↓
content.js injecte lib/api-interceptor.js (page context)
    ↓
API interceptor observe fetch/XHR/SSE → postMessage vers content.js
    ↓
content.js agrège messages (API + DOM) + stratégies provider
    ↓
USER clique "Generate Snapshot" dans popup
    ↓
content.js runSnapshotJob() → RL4SnapshotGenerator.generate()
    ↓
lib/extraction.js → topics/decisions/insights
    ↓
lib/snapshot.js → RCEP_v1 / RCEP_v2 Ultra / UltraPlus
    ↓
lib/checksum.js → canonicalize + SHA‑256 checksum
    ↓
Signature device-only (optionnel) ECDSA P‑256
    ↓
Snapshot stocké (chrome.storage.local) + transcript IndexedDB (background)
    ↓
popup.js construit prompt de handoff + RL4 Blocks encode/finalize
```

### 1.3 Composants Principaux

| Module | Rôle | Fichiers Clés |
|--------|------|---------------|
| **Manifest** | Permissions, hosts, scripts | `manifest.json` |
| **Service Worker** | Orchestration + IndexedDB transcripts | `background.js` |
| **Content Script** | Capture + snapshot job | `content.js` |
| **API Interceptor** | Hook fetch/XHR/SSE (page context) | `lib/api-interceptor.js` |
| **Compression** | Extraction topics/decisions/insights | `lib/extraction.js` |
| **Snapshot** | Génération RCEP | `lib/snapshot.js` |
| **Integrity** | Canonicalize + SHA‑256 + signature | `lib/checksum.js` |
| **UI** | Wizard + prompts + RL4 Blocks | `popup.html`, `popup.js`, `styles/popup.css` |

---

## PARTIE 2 : EXTENSION SHELL / MV3

### 2.1 Manifest & Permissions

**Fichier** : `manifest.json`  
**Points clés** :
- MV3, service worker `background.js`
- `content_scripts` injectés au `document_start`
- permissions : `storage`, `activeTab`, `clipboardWrite`, `sidePanel`, `declarativeContent`
- hosts supportés (Claude/ChatGPT/Gemini/Perplexity/Copilot)

### 2.2 UI entrypoints

- Popup standard : `popup.html` (wizard 4 étapes)
- Side panel : `manifest.json` → `side_panel.default_path = popup.html`
- In‑page widget : injecté par `content.js`, `iframe` vers `popup.html`

---

## PARTIE 3 : CAPTURE LAYER

### 3.1 Content Script (content.js)

**Rôle** : capture messages, synchronise état, exécute le snapshot job.  
**Fonctions critiques** :
- Détection provider (`getProvider()`)
- Injection API interceptor (`injectApiInterceptor()`)
- Job de snapshot (`runSnapshotJob()`), progress heartbeat, persistance last snapshot
- In‑page widget (bouton flottant + iframe)

**Stratégies de capture (haute fidélité → fallback)** :
- **ChatGPT** : surgical fetch conversation JSON → embedded state → request page‑context → DOM
- **Claude** : share API quand `/share/` → conversation API paginée → DOM
- **Perplexity** : thread API `/rest/thread/<slug>` via page‑context
- **Gemini** : DOM + “hydration” virtualisée (scroll/steps)
- **Copilot** : OpenAI‑compat `/chat/completions` (request+response)

**Indicateurs de complétude** :
- `capture_completeness` + `capture_completeness_reason` sont attachés au snapshot
- `capture_strategy` expose la voie réellement utilisée (ex: `chatgpt_surgical`, `claude_api`)

---

### 3.2 API Interceptor (page context)

**Fichier** : `lib/api-interceptor.js`  
**Rôle** : observer les mêmes requêtes que la webapp (fetch/XHR/SSE) sans backend.

**Fonctionnement** :
1. Hook `fetch` et `XMLHttpRequest`
2. Filtrage d’URLs (same‑origin + hosts autorisés)
3. Extraction messages selon provider
4. `postMessage` vers `content.js`

**Cas gérés** :
- ChatGPT conversation JSON (`/backend-api/conversation/...`)
- SSE streams (ChatGPT/OpenAI‑compat)
- Perplexity thread (`/rest/thread/<slug>`)
- OpenAI‑compat `/chat/completions` (request + response)

---

### 3.3 In‑page Widget

**Fichier** : `content.js`  
**Rôle** : injecte un bouton flottant + panel (`iframe` vers `popup.html`) sur pages supportées.

**Comportement** :
- Monté uniquement si provider supporté
- `openRl4InpagePanel` déclenché par clic extension
- Ré‑montage si SPA replace le DOM

---

## PARTIE 4 : COMPRESSION LAYER

### 4.1 Extraction Topics

**Fichier** : `lib/extraction.js`  
**Méthode** :
- Tokenisation Unicode, filtre stopwords (EN/FR + bruit dev)
- TF‑IDF‑ish (fréquence × inverse doc frequency)
- Topics pondérés (max 7), message_refs (max 3)

### 4.2 Extraction Decisions

**Méthode** :
- Regex EN/FR (recommend/decision/choisir/objectif)
- Évite extraction depuis blocs de code ou gabarits longs
- Règles de confiance et options_considered (fallback UNKNOWN)

### 4.3 Extraction Insights

**Méthode** :
- Marqueurs `Important:`, `Note:` (EN/FR)
- Heuristique si conversation courte (goal/objectif)

---

## PARTIE 5 : SNAPSHOT LAYER

### 5.1 RL4SnapshotGenerator

**Fichier** : `lib/snapshot.js`  
**Modes** :
- **Digest** (`RCEP_v1`) : topics/decisions/insights + timeline_summary + fingerprint transcript
- **Ultra** (`RCEP_v2_Ultra`) : pruning agressif, timeline_macro, no transcript
- **UltraPlus** (`RCEP_v2_UltraPlus`) : Ultra + semantic_validation + semantic_spine + checklist

**Contraintes** :
- Deadline interne 8s (budget)
- Auto‑désactivation transcript sur conversations XXL
- Fingerprint transcript “merkle‑style” (chunks SHA‑256)

### 5.2 Timeline

- `timeline_summary` (Digest) : tranches par range de messages, extraits non‑sémantiques
- `timeline_macro` (Ultra/UltraPlus) : phases basées sur ranges + keywords

---

## PARTIE 6 : INTEGRITY LAYER

### 6.1 Canonicalisation + Checksum

**Fichier** : `lib/checksum.js`  
**Process** :
1. `canonicalize()` : tri récursif des clés, exclusion du champ `checksum`
2. `JSON.stringify`
3. SHA‑256 → hex (64 chars)

### 6.2 Integrity Seal (device‑only)

**Fichier** : `content.js`  
**Process** :
- Génère clé ECDSA P‑256 non‑exportable
- Stocke clé dans IndexedDB `rl4_device_keys`
- Signe `checksum:<hex>` (Base64)

**Garanties** :
- Tamper‑evidence device‑only, pas d’identité humaine (cf. SECURITY_MODEL)

---

## PARTIE 7 : STORAGE LAYER

### 7.1 chrome.storage.local

**Usages** :
- `rl4_last_snapshot_v1` + `rl4_last_snapshot_by_tab_v1`
- `rl4_capture_progress_v1` (progress UI)
- `rl4_blocks_v1` + `rl4_blocks_status_v1`
- `rl4_last_prompt_v1`

**Thinning snapshot** :
- Si JSON > ~1.5MB, suppression `transcript_compact` et fallback sur “thin snapshot”

### 7.2 IndexedDB (background)

**DB** : `rl4_transcripts_v1`  
**Stores** :
- `conversations` (convKey)
- `messages` (convKey + idx, index byConvKey)

**Chunking** :
- `computeChunkPlan()` segmente par taille char (défaut 45k)
- `rl4_transcript_get_chunk_prompt` + `rl4_transcript_get_merge_prompt`

### 7.3 IndexedDB (device keys)

**DB** : `rl4_device_keys`  
**Store** : `keys` (clé `device_signing_v1`)

---

## PARTIE 8 : OUTPUT LAYER (UI)

### 8.1 Wizard 4 étapes

1. **Generate Snapshot**
2. **Copy finalization prompt** (RL4 Blocks encoder)
3. **Paste LLM response** (blocks)
4. **Copy Final Prompt** (handoff JSON)

### 8.2 Provider‑specific framing

- **Copilot** : évite langage “protocol/system”, génère RL4 Blocks localement
- **Perplexity** : transcript supprimé si trop gros (risque “file analysis”)

### 8.3 Normalisation RL4 Blocks

**But** : corriger variations de format (ex: `patterns:` → `patterns=`)  
**Fichier** : `popup.js` (`normalizeRl4BlocksText`)

---

## PARTIE 9 : FORMATS RCEP

### 9.1 RCEP_v1 Digest

Champs principaux :
- `_branding`, `producer`, `protocol`, `version`, `session_id`, `timestamp`
- `topics`, `decisions`, `insights`
- `context_summary`, `timeline_summary`
- `conversation_fingerprint`
- `metadata`, `checksum`
- `transcript_compact` (optionnel)

### 9.2 RCEP_v2 Ultra / UltraPlus

**Ultra** :
- Topics/decisions pruned, `timeline_macro`, pas de transcript

**UltraPlus** :
- `context_summary_ultra`
- `validation_checklist`
- `unknowns`
- `semantic_validation` (structure_only / unverified)
- `semantic_spine` (core_context, main_tension, key_decision, etc.)

**Schémas** : `schemas/rcep_v1_digest.schema.json`, `schemas/rcep_v2_ultra.schema.json`, `schemas/rcep_v2_ultra_plus.schema.json`

---

## PARTIE 10 : SECURITY MODEL (PUBLIC)

**Garanties** :
- Checksum SHA‑256 → détection altérations
- Integrity Seal device‑only → continuité device

**Non‑garanties** :
- Pas de preuve d’identité humaine
- Pas de notarisation
- Pas de validation de vérité sémantique (sans transcript)

---

## PARTIE 11 : LIMITATIONS & RISQUES

1. **Volatilité UI providers** : sélecteurs DOM et endpoints changent fréquemment  
2. **Conversations XXL** : transcript auto‑désactivé, risques de partialité  
3. **Quotas storage** : chrome.storage.local (~5MB) → thinning snapshots  
4. **Copilot** : refus possible de prompts “protocol‑like”  
5. **Schemas vs payload** : vérifier alignement exact (champs exigés vs champs émis)

---

## PARTIE 12 : WORKFLOWS COMPLETS

### 12.1 Generate Snapshot

```
User → Popup "Generate Snapshot"
    ↓
content.js runSnapshotJob()
    ↓
Capture (API/DOM) + messages[]
    ↓
RL4SnapshotGenerator.generate()
    ↓
calculateChecksum() + signature optionnelle
    ↓
Store snapshot + transcript
    ↓
Popup Step 2
```

### 12.2 Finalize RL4 Blocks

```
User → Copy encoder prompt
    ↓
LLM → RL4 Blocks
    ↓
Paste dans Step 3
    ↓
content.js finalizeRl4BlocksManual
    ↓
Popup Step 4 (copy final prompt)
```

### 12.3 Chunk Encoder (long chats)

```
Popup → Copy chunk prompt (N)
    ↓
LLM → chunk notes
    ↓
Save notes
    ↓
Copy merge prompt → RL4 Blocks final
```

---

## PARTIE 13 : SYSTÈMES DE HASHING

### 13.1 Checksum snapshot

**Algorithme** : SHA‑256  
**Input** : JSON canonique (tri récursif, exclusion checksum)  
**Output** : hex 64 chars

### 13.2 Fingerprint transcript

**Algorithme** : SHA‑256 merkle‑style  
**Input** : chunks `transcript_compact`  
**Output** : `conversation_fingerprint.sha256`

### 13.3 Integrity Seal

**Algorithme** : ECDSA P‑256 + SHA‑256  
**Payload signé** : `checksum:<hex>`

---

## PARTIE 14 : OBSERVATIONS FORENSIQUES

1. **Capture provenance** attachée au snapshot (`capture_provider`, `capture_strategy`)  
2. **Transcript store** externalisé en IndexedDB (référence `transcript_ref`)  
3. **Thinning snapshot** si taille > 1.5MB  
4. **Mismatch potentiel schema/payload** : valider les champs requis avant usage strict

---

## ANNEXES

### ANNEXE A : Fichiers de référence

- `manifest.json`
- `background.js`
- `content.js`
- `lib/api-interceptor.js`
- `lib/snapshot.js`
- `lib/extraction.js`
- `lib/checksum.js`
- `popup.html`
- `popup.js`
- `styles/popup.css`
- `docs/SPECIFICATION.md`
- `docs/SECURITY_MODEL.md`
- `docs/WHITEPAPER.md`
- `schemas/*.schema.json`

### ANNEXE B : Diagrammes

Voir PARTIE 1.1 (Architecture Layers) et PARTIE 12 (Workflows).

---

**FIN DU RAPPORT**
