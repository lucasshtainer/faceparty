# FaceParty

Live webcam reactions in the **top half of the Teleparty chat sidebar**. Friends see each other while you watch — peer-to-peer, no account, no server to run.

FaceParty is a **standalone** Chrome extension (Manifest V3). It does not modify Teleparty’s code; it injects its own UI and connects people over WebRTC via PeerJS.

## Features

- Webcam + mic grid docked into Teleparty’s right chat sidebar (top ~50%)
- Chat messages + “Type a message…” stay visible and usable in the bottom half
- Drag handle to resize the video area (25–65%); collapse to a slim bar
- Rooms via 6-character codes and shareable invite links
- Mesh WebRTC for 2–6 people using PeerJS’s free public broker
- Glassmorphic UI, active-speaker glow, cam/mic toggles

## Install (Load unpacked)

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder (`teleparty-webcam extension`)
5. Pin FaceParty from the puzzle-piece menu for easy access
6. **Reload your Netflix (or other) tab** after installing or updating — required so the content script mounts

### If Create seems to do nothing

1. Confirm the Netflix tab is focused (not the extensions page)
2. Reload that Netflix tab, then click **Create room** again
3. When Chrome asks for camera/mic, click **Allow** — the prompt appears for the FaceParty panel (extension), not always as a Netflix permission
4. Look for the FaceParty bar in the top of the Teleparty chat (or top-right if chat isn’t detected yet)

## Start a watch party

1. Open a supported streaming site with Teleparty:
   - Netflix, YouTube, Disney+, Hulu, Max / HBO Max, Prime Video / Amazon
2. Click the **FaceParty** toolbar icon
3. Set your **display name**
4. Click **Create room & copy link**
5. Share the invite link with friends (e.g. `https://faceparty.link/#room=abcd12`)

The link does not need a real website — it only carries the room code in the hash. Friends must have FaceParty installed, open the same kind of streaming tab, paste the link (or code) into the popup, and click **Join**.

## How peer discovery works

PeerJS’s public broker has no room directory, so FaceParty uses a deterministic **hub** peer id per room (`faceparty-<code>-hub`). The first person claims the hub and relays the list of personal peer ids; everyone else mesh-connects to each other. If the hub leaves, remaining peers re-elect a new hub. Details are commented in `content.js`.

## Known limitations

| Topic | Detail |
| --- | --- |
| Party size | Designed for **2–6** people (full mesh) |
| Extension required | Every participant needs FaceParty installed |
| Public broker | Signaling uses PeerJS cloud (`0.peerjs.com`) — free, but not SLA-backed |
| Permissions | Camera/mic prompts are tied to the **streaming site** origin |
| Teleparty DOM | Sidebar class names change; FaceParty uses heuristics + a fixed top-right fallback |
| `faceparty.link` | Not a hosted product page — links only transport `#room=……` |

## Where to tweak things

| What | Where |
| --- | --- |
| Colors / glass look | CSS variables at the top of `content.css` (`--fp-accent`, `--fp-bg`, …) |
| Popup styling | `popup.css` |
| Default panel height | `DEFAULT_PANEL_PCT` in `content.js` (also persisted in `chrome.storage.local`) |
| Resize limits | `MIN_PANEL_PCT` / `MAX_PANEL_PCT` in `content.js` |
| Debug logs | Set `DEBUG = true` at the top of `content.js` |
| Supported sites | `manifest.json` → `host_permissions` + `content_scripts.matches` |

## Project layout

```
manifest.json          Chrome MV3 manifest
background.js          Service worker (popup ↔ tab messaging)
popup.html / .js / .css Toolbar popup
content.js             Sidebar docking + PeerJS mesh + video UI
content.css            Injected styles (all classes prefixed `.fp-`)
lib/peerjs.min.js      Bundled PeerJS 1.5.4 (MV3 CSP — no remote scripts)
icons/                 Extension icons (16 / 48 / 128)
README.md              This file
```

## Privacy notes

- Video/audio is sent **peer-to-peer** (WebRTC), not through a FaceParty server
- PeerJS’s broker only helps peers find each other (signaling); it does not relay media
- Display name and room preference are stored locally in `chrome.storage.local`
- Leaving a room / closing the tab stops local media tracks so the camera light turns off

## Troubleshooting

- **“FaceParty isn't running on this tab”** — Open a supported streaming site first, then use the popup
- **No camera** — Allow camera/mic for that site (lock icon in the address bar), reload, rejoin
- **Panel not in the chat** — Teleparty sidebar may not be open yet; FaceParty falls back to a top-right panel aligned with the chat column and will re-dock when the sidebar appears
- **Can’t see a friend** — Confirm the same 6-character room code, both have the extension, and neither is over the 6-person soft limit

Enjoy the party.
