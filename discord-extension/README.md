# Discord Enhancer — Browser Extension

A Chrome/Edge browser extension that enhances Discord's web UI with three features:

| Feature | How it works |
|---|---|
| **User status dots** | Shows online/idle/DND/offline dot beside every username in chat |
| **Deleted messages** | Keeps deleted messages visible, highlighted in red |
| **Who deleted** | Queries Discord's audit log to show who deleted the message |

> **ToS Notice:** This extension hooks into Discord's internal APIs (Webpack modules, WebSocket gateway) and uses your auth token for audit log queries. This may violate [Discord's Terms of Service](https://discord.com/terms). Use at your own risk, on accounts you are comfortable risking.

---

## Installation (Chrome / Edge / Brave)

Chrome does not allow direct `.zip` installs of unsigned extensions — you load it as an **unpacked extension** from the folder.

1. Download or clone this folder (`discord-extension/`) to your computer
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the `discord-extension` folder
6. Navigate to [discord.com](https://discord.com) — the extension activates automatically

To update after any code change: go back to `chrome://extensions` and click the **↻ refresh** icon on the Discord Enhancer card.

---

## Installation (Firefox)

Firefox requires a temporary install for unsigned extensions:

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select the `manifest.json` file inside the `discord-extension` folder

> Temporary Firefox add-ons are removed on browser restart. For permanent install, the extension would need to be signed via [AMO](https://addons.mozilla.org).

---

## How each feature works

### Status Dots
- The WebSocket interceptor listens for `PRESENCE_UPDATE` gateway events
- Presence is seeded from the `READY` payload on login (covers people already online)
- A `MutationObserver` watches for new messages in the DOM and injects a coloured dot after the username
- Hover the dot for a tooltip (Online / Idle / Do Not Disturb / Offline / Streaming)

### Deleted Messages
- Every `MESSAGE_CREATE` gateway event is cached (last 500 messages per session)
- On `MESSAGE_DELETE`, the cached content re-displays the message if Discord removes it from the DOM
- The message gets a red left-border and a **Deleted** badge in the header
- A `MutationObserver` re-inserts the element if Discord removes it

### Who Deleted It
- Immediately after a delete event, the extension calls `GET /api/v10/guilds/{id}/audit-logs?action_type=72` using your own Discord auth token (extracted from Discord's internal module system)
- It matches audit log entries for the correct channel within a 15-second window
- If found, it appends *"Deleted by Username"* beneath the message

**Limitations of who-deleted:**
- Only works in servers — DMs have no audit log
- If the author deleted their own message, Discord may not log it
- Requires **View Audit Log** permission in the server
- Discord's API matches by channel, not by specific message ID

---

## File structure

```
discord-extension/
├── manifest.json      # Extension manifest (MV3)
├── background.js      # Minimal service worker
├── content.js         # Injects injected.js into page context
├── injected.js        # Core logic: WebSocket patch, DOM manipulation, API calls
├── styles.css         # Red highlight, status dot, tooltip styles
├── README.md          # This file
└── icons/             # Extension icons (16, 48, 128 px)
```

---

## Customisation quick-reference

| What to change | File | Thing to edit |
|---|---|---|
| Red highlight colour | `styles.css` | `.de-deleted-message` background/border |
| Status dot size | `styles.css` | `.de-status-dot` width/height |
| Message cache size | `injected.js` | `MAX_CACHE` constant |
| Audit log time window | `injected.js` | `15_000` ms in `fetchAuditLogDeleter` |
| Status colours | `styles.css` | `.de-status-dot[data-status="…"]` rules |
