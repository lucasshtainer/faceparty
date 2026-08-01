/**
 * FaceParty — background service worker (Manifest V3)
 *
 * - Stores defaults
 * - Creates room codes immediately (so the popup never waits on camera/PeerJS)
 * - Injects the content script if the tab was open before the extension loaded
 * - Forwards commands to the content script (which relays into the panel iframe)
 */

const DEFAULTS = {
  displayName: "Guest",
  camOnByDefault: true,
  micOnByDefault: true,
  panelHeightPct: 48,
  panelCollapsed: false,
  activeRoom: null,
};

const MATCH_HOSTS = [
  "netflix.com",
  "youtube.com",
  "disneyplus.com",
  "hulu.com",
  "hbomax.com",
  "max.com",
  "primevideo.com",
  "amazon.com",
];

function inviteLink(code) {
  return `https://faceparty.link/#room=${code}`;
}

function randomCode() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function isSupportedUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return MATCH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(null);
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (stored[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/**
 * Inject content script + CSS if the tab doesn't have FaceParty yet
 * (common right after Load unpacked — existing Netflix tabs need a refresh
 * or this injection).
 */
async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "HOST_PING" });
    if (ping?.ok) return true;
  } catch (_) {
    // Not injected yet.
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    // Give the host a moment to mount the iframe.
    await new Promise((r) => setTimeout(r, 150));
    return true;
  } catch (err) {
    console.warn("[FaceParty] inject failed", err);
    return false;
  }
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return { ok: false, error: "No active tab." };
  }
  if (!isSupportedUrl(tab.url)) {
    return {
      ok: false,
      error:
        "Open a Netflix / YouTube / Disney+ / Hulu / Max / Prime Video tab first, then click Create.",
    };
  }

  const injected = await ensureContentScript(tab.id);
  if (!injected) {
    return {
      ok: false,
      error: "Could not start FaceParty on this tab. Reload the page and try again.",
    };
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    return {
      ok: false,
      error:
        "FaceParty isn't running on this tab. Reload Netflix and try again.",
    };
  }
}

/** Open (or focus) the top-level page that can actually prompt for camera/mic. */
async function openMediaPermissionWindow() {
  const url = chrome.runtime.getURL("permission.html");
  const existing = await chrome.windows.getAll({ populate: true });
  for (const win of existing) {
    const hit = win.tabs?.find((t) => t.url === url);
    if (hit?.windowId != null) {
      await chrome.windows.update(hit.windowId, { focused: true });
      return { ok: true, reused: true };
    }
  }

  await chrome.windows.create({
    url,
    type: "popup",
    width: 460,
    height: 420,
    focused: true,
  });
  return { ok: true, reused: false };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "OPEN_MEDIA_PERMISSION": {
        sendResponse(await openMediaPermissionWindow());
        break;
      }

      case "MEDIA_PERMISSION_GRANTED": {
        // Panels watch chrome.storage / this broadcast and retry getUserMedia.
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (!tab.id || !isSupportedUrl(tab.url)) continue;
          chrome.tabs
            .sendMessage(tab.id, { type: "MEDIA_PERMISSION_GRANTED" })
            .catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case "GET_STATE": {
        const state = await chrome.storage.local.get(null);
        sendResponse({ ok: true, state });
        break;
      }

      case "SET_STATE": {
        await chrome.storage.local.set(message.patch || {});
        // Best-effort notify; don't fail settings save if tab isn't ready.
        sendToActiveTab({
          type: "SETTINGS_CHANGED",
          patch: message.patch,
        }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case "CREATE_ROOM": {
        /**
         * Fast path: mint the room code + invite link HERE so the popup can
         * copy/close immediately. Never await camera/PeerJS — those run in the
         * page panel after storage updates (popup would close on the prompt).
         */
        const code = randomCode();
        const tab = await getActiveTab();
        if (!tab?.id || !isSupportedUrl(tab.url)) {
          sendResponse({
            ok: false,
            error:
              "Open a Netflix / YouTube / Disney+ / Hulu / Max / Prime Video tab first, then click Create.",
          });
          break;
        }

        // If FaceParty has never been granted camera, open the permission
        // window now (popup itself can't keep a getUserMedia prompt open).
        const { mediaPermissionGranted } = await chrome.storage.local.get(
          "mediaPermissionGranted"
        );
        if (!mediaPermissionGranted) {
          openMediaPermissionWindow().catch(() => {});
        }

        const injected = await ensureContentScript(tab.id);
        await chrome.storage.local.set({
          activeRoom: { code, joinedAt: Date.now() },
        });

        // Fire-and-forget join. Panel also watches `activeRoom` in storage.
        if (injected) {
          chrome.tabs
            .sendMessage(tab.id, { type: "JOIN_ROOM", roomCode: code })
            .catch(() => {});
        }

        sendResponse({
          ok: true,
          roomCode: code,
          inviteLink: inviteLink(code),
          needsMediaPermission: !mediaPermissionGranted,
          joinWarning: injected
            ? null
            : "Reload the streaming tab if the FaceParty panel doesn’t appear.",
          session: { roomCode: code, peerCount: 1 },
        });
        break;
      }

      case "JOIN_ROOM": {
        const code = String(message.roomCode || "").toLowerCase();
        if (!/^[a-z0-9]{6}$/.test(code)) {
          sendResponse({
            ok: false,
            error: "Room codes are 6 lowercase letters/numbers.",
          });
          break;
        }

        const tab = await getActiveTab();
        if (!tab?.id || !isSupportedUrl(tab.url)) {
          sendResponse({
            ok: false,
            error:
              "Open a supported streaming tab first, then join the room.",
          });
          break;
        }

        const injected = await ensureContentScript(tab.id);
        await chrome.storage.local.set({
          activeRoom: { code, joinedAt: Date.now() },
        });

        // Don't block the popup on getUserMedia / PeerJS.
        if (injected) {
          chrome.tabs
            .sendMessage(tab.id, { type: "JOIN_ROOM", roomCode: code })
            .catch(() => {});
        }

        sendResponse({
          ok: true,
          roomCode: code,
          inviteLink: inviteLink(code),
          joinWarning: injected
            ? null
            : "Reload the streaming tab if the FaceParty panel doesn’t appear.",
          session: { roomCode: code, peerCount: 1 },
        });
        break;
      }

      case "LEAVE_ROOM": {
        await chrome.storage.local.set({ activeRoom: null });
        const result = await sendToActiveTab({ type: "LEAVE_ROOM" });
        sendResponse(result?.ok ? result : { ok: true });
        break;
      }

      case "COPY_INVITE":
      case "TOGGLE_CAM":
      case "TOGGLE_MIC":
      case "GET_SESSION": {
        const result = await sendToActiveTab(message);
        if (message.type === "GET_SESSION" && !result?.ok) {
          const { activeRoom } = await chrome.storage.local.get("activeRoom");
          sendResponse({
            ok: true,
            session: activeRoom?.code
              ? { roomCode: activeRoom.code, peerCount: 1 }
              : null,
          });
        } else {
          sendResponse(result);
        }
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })();

  return true;
});
