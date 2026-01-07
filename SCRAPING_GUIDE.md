# Scraping Guide (Troubleshooting) — RL4 Snapshot Extension

This guide helps you debug cases where the extension captures too few messages (e.g. `total_messages: 1`).

---

## Method 1: Forensic Script (Recommended)

### Steps

1. **Open a shared Claude.ai page**
   - Example: `https://claude.ai/share/<share-id>`

2. **Open DevTools Console**
   - `F12` or `Cmd+Option+I` (macOS) / `Ctrl+Shift+I` (Windows/Linux)
   - Go to the **Console** tab

3. **Paste the full script**
   - Open `forensic-scraper.js`
   - Copy the entire file content
   - Paste into the console and press **Enter**

4. **Get the JSON**
   - The script attempts to copy the JSON to your clipboard
   - If clipboard copy fails, the JSON is printed in the console

5. **Use the JSON**
   - Save it to a `.json` file
   - Or feed it into your snapshot workflow

---

## Method 2: Network Inspection (Manual)

### Steps

1. Open DevTools → **Network**
2. Reload the page (`Cmd+R` / `Ctrl+R`)
3. Filter requests by **Fetch/XHR**
4. Look for endpoints like:
   - `/api/chat_snapshots/`
   - `/api/shares/`
   - `/backend-api/`
5. Open a request → **Response** and copy the full JSON
6. Extract messages from arrays like `messages` or `chat_messages` (fields typically include `role` and `content`)

---

## Method 3: Application tab (IndexedDB) — Advanced

### Steps

1. Open DevTools → **Application**
2. Look under **IndexedDB** for Claude/Anthropic databases (often `claude-*` / `anthropic-*`)
3. Inspect stores that look like `messages`, `conversations`, `chat`
4. Export or copy data manually

---

## Expected output format

The forensic script outputs a JSON object like:

```json
{
  "share_id": "<share-id>",
  "url": "https://claude.ai/share/...",
  "extracted_at": "2026-01-06T21:46:29.078Z",
  "extraction_method": "api",
  "successful_endpoint": "/api/chat_snapshots/...",
  "total_messages": 42,
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "content": "First message...",
      "timestamp": "2026-01-06T..."
    },
    {
      "id": "msg-2",
      "role": "assistant",
      "content": "Claude response...",
      "timestamp": "2026-01-06T..."
    }
  ]
}
```

---

## Troubleshooting

### The script finds zero messages

1. Make sure you are on a `/share/` page
2. Check the console for errors (look for `[RL4]` logs)
3. Reload the page (content may not be hydrated yet)
4. Ensure requests to `claude.ai/api/` are allowed

### The script finds messages but the extension does not

1. Reload the extension (`chrome://extensions/` → **Reload**)
2. Reload the page (`Cmd+R` / `Ctrl+R`)
3. Check extension logs in DevTools console (look for `[RL4]`)
4. Use the forensic script as a fallback (most reliable for shared pages)

---

## Next steps

Once you have the full JSON:
1. Generate an RCEP snapshot with the extension
2. Paste it into any other LLM to continue
3. Share the snapshot (portable + integrity-checked)

