# Architecture (public) — RL4 Snapshot Chrome Extension (RCEP™ Reference Implementation)

This document explains the architecture of the **Chrome extension** and the **RCEP™ payloads** it produces.

It is intentionally scoped to the browser add-on + protocol output.

---

## 1) Layers (browser-only)

```
┌─────────────────────────────────────────────────────────────┐
│                    EXTENSION UI LAYER                       │
│  popup.html + popup.js + popup.css                           │
│  - user selects profile (Compact / Ultra+ / Transcript)      │
│  - user generates context, then copies prompt                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    CAPTURE LAYER                            │
│  content.js                                                   │
│  - DOM capture (Claude / ChatGPT / Gemini)                    │
│  - API interception (same-origin fetch/xhr mirror)            │
│  - Hydration for virtualized history (Gemini)                 │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    COMPRESSION LAYER                        │
│  lib/extraction.js                                            │
│  - topic extraction (TF-IDF-ish, stopwords, pruning)          │
│  - decision extraction (pattern-based)                        │
│  - insight extraction (marker-based)                          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    SNAPSHOT LAYER                           │
│  lib/snapshot.js                                              │
│  - builds RCEP_v1 (digest) or RCEP_v2_Ultra / UltraPlus       │
│  - timeline_macro + minimal hints                             │
│  - conversation fingerprint                                   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    INTEGRITY LAYER                          │
│  lib/checksum.js + popup.js                                   │
│  - canonicalize + checksum (SHA-256)                          │
│  - optional device-only Integrity Seal (ECDSA P-256)          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    OUTPUT LAYER                             │
│  popup.js                                                     │
│  - prompt wrapper for cross-LLM paste                          │
│  - raw JSON view for power users                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 2) Data flow (user-centric)

```
User opens a chat (Claude / ChatGPT / Gemini)
  ↓
Extension captures messages (DOM + optional API mirror)
  ↓
User clicks "Generate Context"
  ↓
Generator builds a compact RCEP payload (profile-dependent)
  ↓
Checksum is computed (canonicalized JSON)
  ↓
Optional Integrity Seal signs the checksum (device-only)
  ↓
User clicks "Copy Prompt to Clipboard"
  ↓
User pastes into another LLM and continues
```

---

## 3) Why this is broadly useful (not just for developers)
The payload structure is domain-agnostic:
- **Context**: what the session is about
- **Decisions**: what was chosen and why (as detectable)
- **Constraints**: what must remain true
- **Timeline**: how the session progressed

Examples:
- Legal: contract negotiation context, decision points, constraints (jurisdiction).
- Medical: patient history, treatment decision, contraindications.
- Business: meeting notes, decisions, blockers, next steps.

---

## 4) Security model (public)
RCEP outputs support:
- **Checksum (SHA-256)**: tamper detection.
- **Device-only Integrity Seal (ECDSA P-256)**: “this file was sealed by the same device key”.

It does **not** claim:
- identity proof of a person,
- legal notarization,
- semantic truth validation.


