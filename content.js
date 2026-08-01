/**
 * FaceParty — content script (host page)
 *
 * Slim launcher docked into the Teleparty chat sidebar.
 * Camera + PeerJS run in a floating chrome-extension window (not here),
 * because Netflix blocks getUserMedia inside page iframes.
 */

(() => {
  "use strict";

  const state = {
    dock: { mode: null, sidebar: null, messages: null, toolbar: null },
    observer: null,
    roomCode: null,
  };

  let root;

  function buildLauncher() {
    if (document.getElementById("fp-root")) {
      root = document.getElementById("fp-root");
      return;
    }

    root = document.createElement("div");
    root.id = "fp-root";
    root.className = "fp-launcher-root";
    root.innerHTML = `
      <div class="fp-launcher">
        <div class="fp-launcher__text">
          <span class="fp-logo">FaceParty</span>
          <span class="fp-launcher__status" id="fp-launch-status">Webcams open in a floating window</span>
        </div>
        <div class="fp-launcher__actions">
          <button type="button" class="fp-btn fp-btn--accent" id="fp-open-window">Open window</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);

    root.querySelector("#fp-open-window").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_FLOATING_PANEL" }).catch(() => {});
    });
  }

  function updateStatus() {
    const el = document.getElementById("fp-launch-status");
    if (!el) return;
    el.textContent = state.roomCode
      ? `Room ${state.roomCode} · floating window`
      : "Webcams open in a floating window";
  }

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
          (rect.width > 400 && rect.width < 500 ? 2 : 0),
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
        (a, b) =>
          b.getBoundingClientRect().height - a.getBoundingClientRect().height
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
      state.dock.messages.style.removeProperty("flex");
      state.dock.messages.style.removeProperty("min-height");
      state.dock.messages.style.removeProperty("overflow");
    }
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
    if (messages) {
      messages.classList.add("fp-tp-messages-shrunk");
      messages.style.flex = "1 1 auto";
      messages.style.minHeight = "0";
      messages.style.overflow = "auto";
    }
    return true;
  }

  function dockFallback() {
    clearDockClasses();
    state.dock = { mode: "fallback", sidebar: null, messages: null, toolbar: null };
    if (root.parentElement !== document.documentElement) {
      document.documentElement.appendChild(root);
    }
    root.classList.add("fp-fallback", "fp-launcher-fallback");
  }

  function ensureDocked() {
    buildLauncher();
    updateStatus();
    const sidebar = findTelepartySidebar();
    if (sidebar) {
      if (
        state.dock.mode !== "sidebar" ||
        state.dock.sidebar !== sidebar ||
        !sidebar.contains(root)
      ) {
        dockIntoSidebar(sidebar);
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "HOST_PING") {
      ensureDocked();
      sendResponse({ ok: true, ready: true });
      return true;
    }
    // Room commands are handled by the floating panel — ignore here.
    if (
      message?.type === "JOIN_ROOM" ||
      message?.type === "CREATE_ROOM" ||
      message?.type === "LEAVE_ROOM" ||
      message?.type === "GET_SESSION" ||
      message?.type === "COPY_INVITE" ||
      message?.type === "TOGGLE_CAM" ||
      message?.type === "TOGGLE_MIC" ||
      message?.type === "SETTINGS_CHANGED" ||
      message?.type === "MEDIA_PERMISSION_GRANTED"
    ) {
      sendResponse({ ok: true, ignoredByHost: true });
      return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.activeRoom) {
      state.roomCode = changes.activeRoom.newValue?.code || null;
      updateStatus();
      ensureDocked();
      if (state.roomCode) {
        // Nudge the floating window open when a room becomes active.
        chrome.runtime
          .sendMessage({ type: "OPEN_FLOATING_PANEL" })
          .catch(() => {});
      }
    }
  });

  (async function init() {
    const stored = await chrome.storage.local.get("activeRoom");
    state.roomCode = stored.activeRoom?.code || null;
    ensureDocked();
    startDockObserver();
  })();
})();
