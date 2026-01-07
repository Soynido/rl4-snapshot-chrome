# RL4 Snapshot Extension (Chrome) — RCEP™ Reference Implementation

Chrome extension that captures Claude / ChatGPT / Gemini conversations and generates **RCEP™ context packages** for cross‑LLM continuity (Compact / Ultra / Ultra+), with SHA‑256 checksum + optional device-only Integrity Seal.

This repo is a **public-friendly reference implementation** of the RCEP™ payload format. It does not include any IDE / kernel components.

## Installation

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `rl4-snapshot-extension` folder

## Utilisation

1. Open a conversation on Claude / ChatGPT / Gemini
2. Click **Generate Context**
3. Check Messages / Compression / Checksum
4. Click **Copy Prompt to Clipboard**
5. Paste into any other LLM and continue

## Docs (public)
- `RCEP_PROTOCOL.md`: RCEP™ payload profiles and fields
- `ARCHITECTURE_PUBLIC.md`: browser-only architecture & data flow
- `examples/`: Example RCEP™ payloads (Ultra+, Sealed, Digest)

## Planned public repo (spec-only)
If/when published, the spec will live in a standalone repo named **`RCEP-Protocol`** (spec + examples).  
This extension will remain the reference implementation.

## Notes

- DOM selectors can change when providers update their UI.
- “Integrity Seal” is **device-only** (offline). It detects edits; it does not prove human identity.

## License

MIT

