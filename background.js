/**
 * FaceParty — background service worker (Manifest V3)
 *
 * Owns the floating FaceParty window (where camera + PeerJS actually run).
 * The Netflix content script only shows a slim launcher bar in the chat sidebar.
 */

const DEFAULTS = {
  displayName: "Guest",
  camOnByDefault: true,
  micOnByDefault: true,
  panelHeightPct: 48,
  panelCollapsed: false,
  activeRoom: null,
  mediaPermissionGranted: false,
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

/** @type {number | null} */
let floatingWindowId = null;

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

function panelUrl() {
  return chrome.runtime.getURL("panel.html");
}

function permissionUrl() {
  return chrome.runtime.getURL("permission.html");
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(null);
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (stored[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === floatingWindowId) floatingWindowId = null;
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "HOST_PING" });
    if (ping?.ok) return true;
  } catch (_) {
    /* not injected */
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
    await delay(100);
    return true;
  } catch (err) {
    console.warn("[FaceParty] inject failed", err);
    return false;
  }
}

/**
 * Open or focus the floating FaceParty window.
 * Camera works here because this is a top-level chrome-extension:// page.
 */
async function openFloatingPanel({ focus = true } = {}) {
  const url = panelUrl();

  if (floatingWindowId != null) {
    try {
      await chrome.windows.update(floatingWindowId, { focused: focus });
      return { ok: true, windowId: floatingWindowId, reused: true };
    } catch (_) {
      floatingWindowId = null;
    }
  }

  const existing = await chrome.windows.getAll({ populate: true });
  for (const win of existing) {
    const hit = win.tabs?.find(
      (t) => t.url === url || (t.url && t.url.startsWith(url))
    );
    if (hit && win.id != null) {
      floatingWindowId = win.id;
      if (focus) await chrome.windows.update(win.id, { focused: true });
      return { ok: true, windowId: win.id, reused: true };
    }
  }

  // Place near the right edge so it sits beside typical Teleparty chat.
  let left = 80;
  let top = 80;
  try {
    const current = await chrome.windows.getLastFocused();
    if (current?.width != null && current.left != null) {
      left = Math.max(0, current.left + (current.width || 1200) - 460);
      top = Math.max(0, (current.top || 0) + 60);
    }
  } catch (_) {
    /* ignore */
  }

  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: 400,
    height: 540,
    left,
    top,
    focused: focus,
  });
  floatingWindowId = win.id ?? null;
  return { ok: true, windowId: floatingWindowId, reused: false };
}

async function getFloatingPanelTabId() {
  if (floatingWindowId == null) {
    const opened = await openFloatingPanel({ focus: false });
    if (!opened.ok) return null;
  }
  try {
    const win = await chrome.windows.get(floatingWindowId, { populate: true });
    return win.tabs?.[0]?.id ?? null;
  } catch (_) {
    floatingWindowId = null;
    return null;
  }
}

/** Send a message to the floating panel, retrying briefly while it boots. */
async function sendToFloatingPanel(message, { open = true } = {}) {
  if (open) await openFloatingPanel({ focus: true });
  let tabId = await getFloatingPanelTabId();
  if (tabId == null && open) {
    await openFloatingPanel({ focus: true });
    tabId = await getFloatingPanelTabId();
  }
  if (tabId == null) {
    return { ok: false, error: "Could not open FaceParty window." };
  }

  for (let i = 0; i < 25; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (_) {
      await delay(120);
    }
  }
  return {
    ok: false,
    error: "FaceParty window is open but not ready yet — try again in a second.",
  };
}

async function openMediaPermissionWindow() {
  const url = permissionUrl();
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

async function startRoom(code) {
  const tab = await getActiveTab();
  if (!tab?.id || !isSupportedUrl(tab.url)) {
    return {
      ok: false,
      error:
        "Open a Netflix / YouTube / Disney+ / Hulu / Max / Prime Video tab first.",
    };
  }

  await chrome.storage.local.set({
    activeRoom: { code, joinedAt: Date.now() },
  });

  // Sidebar launcher strip (no camera there).
  ensureContentScript(tab.id).catch(() => {});

  // Open the floating window immediately. Don't await join/getUserMedia —
  // the panel auto-joins from storage when it boots (and retries on message).
  await openFloatingPanel({ focus: true });
  sendToFloatingPanel({ type: "JOIN_ROOM", roomCode: code }, { open: false }).catch(
    () => {}
  );

  return {
    ok: true,
    roomCode: code,
    inviteLink: inviteLink(code),
    session: { roomCode: code, peerCount: 1 },
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "OPEN_FLOATING_PANEL": {
        sendResponse(await openFloatingPanel({ focus: true }));
        break;
      }

      case "OPEN_MEDIA_PERMISSION": {
        sendResponse(await openMediaPermissionWindow());
        break;
      }

      case "MEDIA_PERMISSION_GRANTED": {
        // Tell the floating panel to retry camera.
        sendToFloatingPanel(
          { type: "MEDIA_PERMISSION_GRANTED" },
          { open: false }
        ).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case "GET_STATE": {
        sendResponse({ ok: true, state: await chrome.storage.local.get(null) });
        break;
      }

      case "SET_STATE": {
        await chrome.storage.local.set(message.patch || {});
        sendToFloatingPanel(
          { type: "SETTINGS_CHANGED", patch: message.patch },
          { open: false }
        ).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case "CREATE_ROOM": {
        sendResponse(await startRoom(randomCode()));
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
        sendResponse(await startRoom(code));
        break;
      }

      case "LEAVE_ROOM": {
        await chrome.storage.local.set({ activeRoom: null });
        const result = await sendToFloatingPanel(
          { type: "LEAVE_ROOM" },
          { open: false }
        );
        sendResponse(result?.ok ? result : { ok: true });
        break;
      }

      case "COPY_INVITE":
      case "TOGGLE_CAM":
      case "TOGGLE_MIC":
      case "GET_SESSION": {
        const result = await sendToFloatingPanel(message, {
          open: message.type !== "GET_SESSION",
        });
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

      case "PANEL_READY": {
        // Floating panel booted; remember its window if we can.
        if (sender.tab?.windowId != null) {
          floatingWindowId = sender.tab.windowId;
        }
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })();

  return true;
});
