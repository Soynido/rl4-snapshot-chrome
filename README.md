<div align="center">
  <img src="assets/logo.png" alt="RL4 Logo" width="200" />
  <h1>RL4 Snapshot Extension (Chrome)</h1>
  <p><strong>RCEP™ Reference Implementation</strong></p>
</div>

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

## Related repos

- **[RCEP-Protocol](https://github.com/Soynido/RCEP-Protocol)**: The RCEP™ specification repository (spec + examples)  
  This extension is the **reference implementation** of that protocol.

## Notes

- DOM selectors can change when providers update their UI.
- “Integrity Seal” is **device-only** (offline). It detects edits; it does not prove human identity.

## License

MIT

