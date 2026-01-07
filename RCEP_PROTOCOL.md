# RCEP™ Protocol (public spec) — Reference Implementation: RL4 Snapshot (Chrome)

RCEP™ (**Reasoning Context Encoding Protocol**) is a **portable context package** format designed to move “cognitive state” between LLMs without re-explaining everything.

This repository contains a **reference implementation** (Chrome extension) that generates RCEP payloads from Claude / ChatGPT / Gemini chats.

## Goals
- **Portability**: paste once, continue anywhere.
- **Determinism**: stable fields, explicit unknowns, explicit “unverified” semantic status when transcript is omitted.
- **Integrity**:
  - **Checksum** (SHA-256 of canonicalized JSON) for tamper detection.
  - Optional **Integrity Seal**: device-only ECDSA signature over the checksum.

## Non-goals
- “Truth validation”: RCEP can preserve structure + integrity; it does **not** guarantee semantic correctness without additional verification.

---

## Wire format (high level)
RCEP payloads are JSON objects with:
- **Protocol identity**: `protocol` (string)
- **Session identity**: `session_id`, `timestamp`
- **Structured cognition**: `topics`, `decisions`, `timeline_*`
- **Integrity**: `conversation_fingerprint`, `checksum`, optional `signature`
- **Producer**: `producer` + `_branding` (human-visible header)

### Producer + branding (required in this implementation)
- `_branding`: a human-facing header intended to be seen first in raw JSON.
- `producer`: machine-readable producer metadata.

---

## Profiles
This implementation supports 3 practical profiles:

### 1) Digest (RCEP_v1)
Designed to stay small while preserving:
- `topics`, `decisions`, `insights`
- `context_summary`
- `timeline_summary` (heuristic)
- `conversation_fingerprint` (SHA-256 of a compact transcript)

Transcript may be optionally included as `transcript_compact` (not recommended for small context windows).

### 2) Ultra (RCEP_v2_Ultra)
Aggressive size reduction:
- **No transcript**
- Topics pruned (weight threshold)
- Decisions pruned (confidence/intents)
- `timeline_macro` (few phases)

### 3) Ultra+ (RCEP_v2_UltraPlus)
Ultra + minimal semantic hints:
- `context_summary_ultra` (≤ 280 chars)
- `validation_checklist` (extracted “If …” checks from decision text)
- `unknowns` (tokens observed but undefined)
- `semantic_validation` (explicitly: structure-only / unverified semantics)

---

## Integrity Seal (device-only, offline)
Optional field: `signature` (root-level).

### What it guarantees
- If **any** field changes after export, the checksum changes → signature verification fails.
- A stable `key_id` lets you recognize “same device identity” across files.

### What it does NOT guarantee
- It does not prove who the human is.
- It does not prevent a compromised device from signing bad data.

### Signature object
```json
{
  "type": "device_integrity_v1",
  "algo": "ECDSA_P256_SHA256",
  "key_id": "sha256(spki_public_key)",
  "public_key_spki": "base64(spki)",
  "signed_payload": "checksum:<hex>",
  "value": "base64(signature)"
}
```

---

## Compatibility notes
- All payloads are plain JSON (no binary).
- “Ultra” profiles are designed for tight LLM context windows.
- For media (images/videos), the recommended pattern is **reference-by-hash** (store a hash + short description), not raw bytes.


