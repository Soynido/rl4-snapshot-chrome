<div align="center">
  <img src="assets/logo.png" alt="RL4 Snapshot" width="120" />
  <h1>RL4 Snapshot — Chrome Extension</h1>
  <p><strong>Cross-LLM Memory for AI Conversations</strong></p>
  
  <p>
    <a href="https://github.com/Soynido/rl4-snapshot-chrome/releases"><img src="https://img.shields.io/github/v/release/Soynido/rl4-snapshot-chrome?style=flat-square" alt="Release"></a>
    <a href="https://github.com/Soynido/rl4-snapshot-chrome/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
    <a href="#supported-llms"><img src="https://img.shields.io/badge/LLMs-Claude%20%7C%20ChatGPT%20%7C%20Gemini%20%7C%20Perplexity%20%7C%20Copilot-green?style=flat-square" alt="Supported LLMs"></a>
  </p>
</div>

---

## The Problem

You're deep into a complex project with Claude. You need to switch to ChatGPT for a specific task. But now you have to re-explain everything: your architecture, constraints, decisions, and context.

**RL4 Snapshot solves this.**

## What It Does

RL4 captures your LLM conversation and generates a **portable context package** that any other LLM can understand instantly.

```
Claude conversation (50+ messages) → RL4 Snapshot → Paste into ChatGPT → Continue seamlessly
```

**No re-explaining. No context loss. Just continuity.**

## Supported LLMs

| Provider | Capture | Paste & Continue |
|----------|---------|------------------|
| Claude | ✅ | ✅ |
| ChatGPT | ✅ | ✅ |
| Gemini | ✅ | ✅ |
| Perplexity | ✅ | ✅ |
| Copilot | ✅ | ✅ |

## Features

- **One-click capture** — Extract full conversation with topics, decisions, and timeline
- **Smart compression** — 20-100x compression while preserving semantic meaning
- **Integrity verification** — SHA-256 checksum proves the snapshot wasn't tampered with
- **Multiple formats** — Compact (default), Ultra, and Ultra+ for different needs
- **Works offline** — All processing happens locally in your browser

## Installation

### From Source (Developer Mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/Soynido/rl4-snapshot-chrome.git
   ```

2. Open Chrome → `chrome://extensions/`

3. Enable **Developer mode** (top right)

4. Click **Load unpacked**

5. Select the `rl4-snapshot-chrome` folder

## Usage

1. **Open** any conversation on Claude, ChatGPT, Gemini, Perplexity, or Copilot

2. **Click** the RL4 icon in your browser toolbar

3. **Generate** your context snapshot

4. **Copy** the final prompt

5. **Paste** into any other LLM and continue your work

## How It Works

RL4 Snapshot implements the **RCEP™ protocol** (Reasoning Context Exchange Protocol):

```
┌─────────────────────────────────────────────────────────┐
│                    Your Conversation                     │
│  "Let's build a REST API with auth..."                  │
│  "I recommend JWT tokens because..."                     │
│  "Let's add rate limiting..."                           │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                   RL4 Snapshot Engine                    │
│  • Extract topics (REST API, JWT, rate limiting)        │
│  • Identify decisions (JWT over sessions)               │
│  • Build timeline (phases of work)                      │
│  • Generate checksum (integrity proof)                  │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                 Portable Context Package                 │
│  <RL4-ARCH>phase:implementation|compress:45x</RL4-ARCH> │
│  <RL4-TOPICS>REST API;JWT auth;rate limiting</RL4-TOPICS>│
│  <RL4-DECISIONS>JWT over sessions @85%</RL4-DECISIONS>  │
└─────────────────────────────────────────────────────────┘
```

## Documentation

| Document | Description |
|----------|-------------|
| [WHITEPAPER.md](docs/WHITEPAPER.md) | Conceptual overview & threat model |
| [SPECIFICATION.md](docs/SPECIFICATION.md) | Normative MUST/SHOULD rules |
| [SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | What is and isn't guaranteed |
| [DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Visual language & UI patterns |

## Related Projects

| Project | Description |
|---------|-------------|
| [rl4-cursor-extension](https://github.com/Soynido/rl4-cursor-extension) | RL4 Snapshot for Cursor IDE |
| [RCEP-Protocol](https://github.com/Soynido/RCEP-Protocol) | RCEP™ specification & examples |

## Privacy

- **100% local** — No data leaves your browser
- **No accounts** — No sign-up required
- **No tracking** — Zero analytics or telemetry
- **Open source** — Audit the code yourself

## Contributing

Contributions are welcome! Please read the existing code style and submit PRs against `main`.

## License

MIT — See [LICENSE](LICENSE) for details.

---

<div align="center">
  <p><strong>Stop re-explaining. Start continuing.</strong></p>
  <p>Made with ❤️ for developers who work across multiple LLMs</p>
</div>
