/**
 * FaceParty — content script (host page)
 *
 * Responsibilities:
 *  1) Find Teleparty's chat sidebar (or fall back to top-right)
 *  2) Dock an extension-origin iframe that runs camera + PeerJS
 *  3) Relay popup/background commands into that iframe
 *  4) Drag-resize / collapse the dock height
 *
 * Camera/WebRTC intentionally do NOT run here — Netflix and other streamers
 * often block getUserMedia via Permissions-Policy on the page origin.
 */

(() => {
  "use strict";

  const DEBUG = false;
  const MIN_PANEL_PCT = 25;
  const MAX_PANEL_PCT = 65;
  const DEFAULT_PANEL_PCT = 48;
  const PANEL_URL = chrome.runtime.getURL("panel.html");

  const state = {
    panelHeightPct: DEFAULT_PANEL_PCT,
    panelCollapsed: false,
    dock: { mode: null, sidebar: null, messages: null, toolbar: null },
    observer: null,
    pending: new Map(), // requestId -> {resolve, timer}
    lastSession: null,
    iframeReady: false,
  };

  let root;
  let frame;
  let resizeHandle;

  function log(...args) {
    if (DEBUG) console.log("[FaceParty:host]", ...args);
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get([
      "panelHeightPct",
      "panelCollapsed",
    ]);
    state.panelHeightPct = clamp(
      Number(stored.panelHeightPct) || DEFAULT_PANEL_PCT,
      MIN_PANEL_PCT,
      MAX_PANEL_PCT
    );
    state.panelCollapsed = Boolean(stored.panelCollapsed);
  }

  function buildHost() {
    if (document.getElementById("fp-root")) {
      root = document.getElementById("fp-root");
      frame = document.getElementById("fp-frame");
      resizeHandle = document.getElementById("fp-resize");
      return;
    }

    root = document.createElement("div");
    root.id = "fp-root";

    frame = document.createElement("iframe");
    frame.id = "fp-frame";
    frame.className = "fp-frame";
    frame.src = PANEL_URL;
    frame.allow = "camera; microphone; autoplay; display-capture";
    frame.setAttribute("allow", "camera; microphone; autoplay");
    // Some Chromium builds also honor this Permissions-Policy attribute:
    frame.setAttribute(
      "allow",
      "camera *; microphone *; autoplay *; clipboard-write *"
    );

    resizeHandle = document.createElement("div");
    resizeHandle.id = "fp-resize";
    resizeHandle.className = "fp-resize";
    resizeHandle.title = "Drag to resize";

    root.append(frame, resizeHandle);
    document.documentElement.appendChild(root);
    setupResizeHandle();
    applyChrome();
  }

  function applyChrome() {
    if (!root) return;
    root.style.setProperty("--fp-panel-h", `${state.panelHeightPct}%`);
    root.classList.toggle("fp-collapsed", state.panelCollapsed);
    if (state.panelCollapsed) {
      // Keep a slim bar so Expand is reachable inside the iframe.
      root.style.setProperty("--fp-panel-h", "36px");
    }
  }

  function setupResizeHandle() {
    let dragging = false;

    const onMove = (e) => {
      if (!dragging || !root) return;
      const clientY = e.clientY ?? e.touches?.[0]?.clientY;
      if (clientY == null) return;

      if (state.dock.mode === "sidebar" && state.dock.sidebar) {
        const bounds = state.dock.sidebar.getBoundingClientRect();
        state.panelHeightPct = Math.round(
          clamp(((clientY - bounds.top) / bounds.height) * 100, MIN_PANEL_PCT, MAX_PANEL_PCT)
        );
      } else {
        state.panelHeightPct = Math.round(
          clamp((clientY / window.innerHeight) * 100, MIN_PANEL_PCT, MAX_PANEL_PCT)
        );
      }
      applyChrome();
      updateDockLayout();
    };

    const onUp = async () => {
      if (!dragging) return;
      dragging = false;
      resizeHandle.classList.remove("is-dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
      await chrome.storage.local.set({ panelHeightPct: state.panelHeightPct });
    };

    const onDown = (e) => {
      if (state.panelCollapsed) return;
      e.preventDefault();
      dragging = true;
      resizeHandle.classList.add("is-dragging");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onUp);
    };

    resizeHandle.addEventListener("mousedown", onDown);
    resizeHandle.addEventListener("touchstart", onDown, { passive: false });
  }

  // ---------- Teleparty docking heuristics ----------

  function findTelepartySidebar() {
    const candidates = [];
    const all = document.querySelectorAll("div, aside, section");

    for (const el of all) {
      if (el.id === "fp-root" || el.closest("#fp-root")) continue;
      const style = window.getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "absolute") continue;

      const rect = el.getBoundingClientRect();
      const rightEdge = Math.abs(rect.right - window.innerWidth) < 8;
      const wideEnough = rect.width >= 340 && rect.width <= 560;
      const tallEnough = rect.height >= window.innerHeight * 0.5;
      if (!rightEdge || !wideEnough || !tallEnough) continue;

      const hasInput = Boolean(
        el.querySelector(
          'textarea, input[type="text"], [contenteditable="true"], [placeholder*="message" i], [aria-label*="message" i]'
        )
      );
      const text = (el.innerText || "").slice(0, 2000);
      const mentionsMessage = /type a message|send a message|chat/i.test(text);
      if (!hasInput && !mentionsMessage) continue;

      candidates.push({
        el,
        score:
          (hasInput ? 5 : 0) +
          (mentionsMessage ? 3 : 0) +
          (rect.width > 400 && rect.width < 500 ? 2 : 0) +
          (style.position === "fixed" ? 1 : 0),
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  function findToolbar(sidebar) {
    if (!sidebar) return null;
    const kids = [...sidebar.children].filter((c) => c.id !== "fp-root");
    for (const kid of kids.slice(0, 4)) {
      const h = kid.getBoundingClientRect().height;
      if (h > 28 && h < 90) return kid;
    }
    return kids[0] || null;
  }

  function findMessageList(sidebar) {
    if (!sidebar) return null;
    const scrollers = [...sidebar.querySelectorAll("div")].filter((el) => {
      if (el.closest("#fp-root")) return false;
      const style = getComputedStyle(el);
      const canScroll =
        style.overflowY === "auto" ||
        style.overflowY === "scroll" ||
        el.scrollHeight > el.clientHeight + 40;
      const rect = el.getBoundingClientRect();
      return canScroll && rect.height > 80 && rect.width > 200;
    });
    if (scrollers.length) {
      scrollers.sort(
        (a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height
      );
      return scrollers[0];
    }
    const kids = [...sidebar.children].filter((c) => c.id !== "fp-root");
    return kids.length >= 2 ? kids[Math.min(1, kids.length - 1)] : null;
  }

  function clearDockClasses() {
    state.dock.sidebar?.classList.remove("fp-tp-sidebar-flex");
    state.dock.messages?.classList.remove("fp-tp-messages-shrunk");
    if (state.dock.messages) {
      state.dock.messages.style.removeProperty("max-height");
      state.dock.messages.style.removeProperty("height");
      state.dock.messages.style.removeProperty("flex");
      state.dock.messages.style.removeProperty("min-height");
      state.dock.messages.style.removeProperty("overflow");
    }
  }

  function updateDockLayout() {
    if (state.dock.mode !== "sidebar" || !state.dock.sidebar || !state.dock.messages) {
      return;
    }
    state.dock.sidebar.classList.add("fp-tp-sidebar-flex");
    state.dock.messages.classList.add("fp-tp-messages-shrunk");
    state.dock.messages.style.flex = "1 1 auto";
    state.dock.messages.style.minHeight = "0";
    state.dock.messages.style.overflow = "auto";
  }

  function dockIntoSidebar(sidebar) {
    const toolbar = findToolbar(sidebar);
    const messages = findMessageList(sidebar);
    if (!toolbar) return false;

    clearDockClasses();
    state.dock = { mode: "sidebar", sidebar, messages, toolbar };
    root.classList.remove("fp-fallback");

    if (toolbar.nextSibling !== root) {
      toolbar.insertAdjacentElement("afterend", root);
    }
    sidebar.classList.add("fp-tp-sidebar-flex");
    applyChrome();
    updateDockLayout();
    log("Docked into sidebar");
    return true;
  }

  function dockFallback() {
    clearDockClasses();
    state.dock = { mode: "fallback", sidebar: null, messages: null, toolbar: null };
    if (root.parentElement !== document.documentElement) {
      document.documentElement.appendChild(root);
    }
    root.classList.add("fp-fallback");
    applyChrome();
    log("Fallback dock");
  }

  function ensureDocked() {
    buildHost();
    const sidebar = findTelepartySidebar();
    if (sidebar) {
      if (
        state.dock.mode !== "sidebar" ||
        state.dock.sidebar !== sidebar ||
        !sidebar.contains(root)
      ) {
        dockIntoSidebar(sidebar);
      } else {
        updateDockLayout();
      }
    } else if (state.dock.mode !== "fallback") {
      dockFallback();
    }
  }

  function startDockObserver() {
    if (state.observer) return;
    let scheduled = false;
    state.observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        ensureDocked();
      });
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    setInterval(ensureDocked, 2500);
  }

  // ---------- iframe RPC ----------

  function callPanel(message, timeoutMs = 20000) {
    return new Promise((resolve) => {
      ensureDocked();
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        state.pending.delete(requestId);
        resolve({
          ok: false,
          error:
            "FaceParty panel did not respond. Reload the Netflix tab and try again.",
        });
      }, timeoutMs);

      state.pending.set(requestId, { resolve, timer });

      const send = () => {
        try {
          frame.contentWindow?.postMessage(
            { target: "faceparty-panel", requestId, ...message },
            chrome.runtime.getURL("/")
          );
        } catch (err) {
          // Fallback: some environments dislike targetOrigin quirks
          frame.contentWindow?.postMessage(
            { target: "faceparty-panel", requestId, ...message },
            "*"
          );
        }
      };

      if (state.iframeReady) send();
      else {
        // Wait briefly for READY, then send anyway.
        const wait = setInterval(() => {
          if (state.iframeReady) {
            clearInterval(wait);
            send();
          }
        }, 50);
        setTimeout(() => {
          clearInterval(wait);
          send();
        }, 1500);
      }
    });
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "faceparty-panel") return;

    if (data.type === "READY") {
      state.iframeReady = true;
      log("Panel ready");
      return;
    }

    if (data.type === "SET_COLLAPSED") {
      state.panelCollapsed = Boolean(data.collapsed);
      applyChrome();
      updateDockLayout();
      return;
    }

    if (data.type === "SESSION") {
      state.lastSession = data.session || null;
      return;
    }

    if (data.type === "COMMAND_RESULT" && data.requestId) {
      const pending = state.pending.get(data.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      state.pending.delete(data.requestId);
      pending.resolve(data.result);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      // Fast path: session cache for popup refresh
      if (message?.type === "GET_SESSION") {
        const live = await callPanel({ type: "GET_SESSION" }, 4000);
        if (live?.ok) {
          state.lastSession = live.session;
          sendResponse(live);
        } else {
          sendResponse({ ok: true, session: state.lastSession });
        }
        return;
      }

      if (message?.type === "HOST_PING") {
        ensureDocked();
        sendResponse({ ok: true, ready: true });
        return;
      }

      // Everything else is handled inside the extension iframe panel.
      const result = await callPanel(message);
      sendResponse(result);
    })();
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.panelHeightPct) {
      state.panelHeightPct = clamp(
        Number(changes.panelHeightPct.newValue) || DEFAULT_PANEL_PCT,
        MIN_PANEL_PCT,
        MAX_PANEL_PCT
      );
      applyChrome();
      updateDockLayout();
    }
    if (changes.panelCollapsed) {
      state.panelCollapsed = Boolean(changes.panelCollapsed.newValue);
      applyChrome();
      updateDockLayout();
    }
    // When popup/background sets activeRoom, make sure the dock is visible
    // so the panel iframe can join (it also watches storage itself).
    if (changes.activeRoom?.newValue?.code) {
      ensureDocked();
    }
  });

  (async function init() {
    await loadSettings();
    ensureDocked();
    startDockObserver();
    log("Host initialized on", location.hostname);
  })();
})();
