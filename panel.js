/**
 * FaceParty — panel (runs inside chrome-extension:// iframe)
 *
 * IMPORTANT: Camera/mic + PeerJS live HERE, not in the Netflix page.
 * Streaming sites often set Permissions-Policy that blocks getUserMedia in
 * page/content-script contexts. An extension-origin iframe is allowed to
 * request camera/mic with allow="camera; microphone".
 *
 * The content script only docks this iframe into the Teleparty sidebar.
 */

(() => {
  "use strict";

  const DEBUG = false;
  const INVITE_ORIGIN = "https://faceparty.link";
  const ROOM_CODE_RE = /^[a-z0-9]{6}$/;
  const MAX_PEERS = 6;
  const HUB_CONNECT_TIMEOUT_MS = 3500;
  const HUB_REELECT_JITTER_MS = 900;
  const MESH_RETRY_MS = 1200;
  const MESH_RETRY_MAX = 12;

  const ICONS = {
    camOn: `<svg viewBox="0 0 24 24"><path d="M17 10.5V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5l4 3.5V7l-4 3.5z"/></svg>`,
    camOff: `<svg viewBox="0 0 24 24"><path d="M3.3 2 2 3.3l4.2 4.2A2 2 0 0 0 5 9v6a2 2 0 0 0 2 2h8c.3 0 .6-.1.9-.2L20.7 21 22 19.7 3.3 2zM17 10.5l4 3.5V7l-4 3.5V7a2 2 0 0 0-2-2h-3.2l7.7 7.7c.3-.4.5-.9.5-1.4v-3.3z"/></svg>`,
    micOn: `<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z"/></svg>`,
    micOff: `<svg viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .4-.1.8-.2 1.1l1.4 1.4A6.9 6.9 0 0 0 19 11zM4.3 3 3 4.3l5.2 5.2V11a3 3 0 0 0 3.7 2.9l1.6 1.6A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.9V21h2v-3.1c.7-.1 1.4-.3 2-.6l3.7 3.7 1.3-1.3L4.3 3zM12 4a1.5 1.5 0 0 1 1.5 1.5v.7L10 9.7V5.5A1.5 1.5 0 0 1 12 4z"/></svg>`,
    link: `<svg viewBox="0 0 24 24"><path d="M3.9 12a5 5 0 0 1 5-5h4v2h-4a3 3 0 1 0 0 6h4v2h-4a5 5 0 0 1-5-5zm7-1h6v2h-6v-2zm4-4h4a5 5 0 1 1 0 10h-4v-2h4a3 3 0 1 0 0-6h-4V7z"/></svg>`,
    leave: `<svg viewBox="0 0 24 24"><path d="M10 17v2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5v2H5v10h5zm9.6-5-3.3-3.3 1.4-1.4L23.4 12l-5.7 5.7-1.4-1.4L19.6 13H10v-2h9.6z"/></svg>`,
    collapse: `<svg viewBox="0 0 24 24"><path d="M7 14l5-5 5 5H7z"/></svg>`,
    expand: `<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5H7z"/></svg>`,
  };

  const state = {
    displayName: "Guest",
    camOnByDefault: true,
    micOnByDefault: true,
    panelCollapsed: false,
    roomCode: null,
    isHub: false,
    localPeerId: null,
    camOn: true,
    micOn: true,
    localStream: null,
    myPeer: null,
    hubPeer: null,
    peers: new Map(),
    joining: false,
    joinEpoch: 0,
    hubConn: null, // live data connection to the room hub (not the hub peer itself)
    hubReelectTimer: null,
    rosterTimer: null,
    mediaPlaceholder: false, // true when using a black dummy stream (camera blocked)
    audioCtx: null,
    rafSpeaking: null,
    _localAnalyser: null,
  };

  const ui = {
    root: document.getElementById("fp-root"),
    pill: document.getElementById("fp-room-pill"),
    empty: document.getElementById("fp-empty"),
    grid: document.getElementById("fp-grid"),
    controls: document.getElementById("fp-controls"),
    camBtn: document.getElementById("fp-cam-btn"),
    micBtn: document.getElementById("fp-mic-btn"),
    linkBtn: document.getElementById("fp-link-btn"),
    leaveBtn: document.getElementById("fp-leave-btn"),
    collapseBtn: document.getElementById("fp-collapse-btn"),
    toast: document.getElementById("fp-toast"),
    emptyCreate: document.getElementById("fp-empty-create"),
    emptyJoin: document.getElementById("fp-empty-join"),
  };

  function log(...args) {
    if (DEBUG) console.log("[FaceParty:panel]", ...args);
  }
  function warn(...args) {
    // peer-unavailable is normal while discovering a hub that doesn't exist yet.
    const first = args[0];
    if (first === "peer-unavailable" || first === "peer error peer-unavailable") return;
    if (typeof first === "string" && first.includes("peer-unavailable")) return;
    console.warn("[FaceParty:panel]", ...args);
  }

  function inviteLink(code) {
    return `${INVITE_ORIGIN}/#room=${code}`;
  }

  function randomId(len = 8) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  function generateRoomCode() {
    return randomId(6);
  }

  function hubIdFor(room) {
    return `faceparty-${room}-hub`;
  }

  function personalIdFor(room) {
    return `faceparty-${room}-${randomId(8)}`;
  }

  function extractRoomCode(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    const hashMatch = text.match(/[#&?]room=([a-z0-9]{6})/i);
    if (hashMatch) return hashMatch[1].toLowerCase();
    const bare = text.match(/\b([a-z0-9]{6})\b/i);
    if (bare) return bare[1].toLowerCase();
    return null;
  }

  function peerCount() {
    return 1 + state.peers.size;
  }

  function sessionSnapshot() {
    return {
      roomCode: state.roomCode,
      peerCount: peerCount(),
      isHub: state.isHub,
      camOn: state.camOn,
      micOn: state.micOn,
      localPeerId: state.localPeerId,
      joining: state.joining,
    };
  }

  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.add("is-show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => ui.toast.classList.remove("is-show"), 2200);
  }

  function postToHost(msg) {
    try {
      parent.postMessage({ source: "faceparty-panel", ...msg }, "*");
    } catch (_) {
      /* ignore */
    }
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get([
      "displayName",
      "camOnByDefault",
      "micOnByDefault",
      "panelCollapsed",
      "activeRoom",
    ]);
    state.displayName = (stored.displayName || "Guest").slice(0, 24);
    state.camOnByDefault = stored.camOnByDefault !== false;
    state.micOnByDefault = stored.micOnByDefault !== false;
    state.panelCollapsed = Boolean(stored.panelCollapsed);
    return stored;
  }

  function applyCollapsedChrome() {
    ui.root.classList.toggle("fp-collapsed", state.panelCollapsed);
    ui.collapseBtn.innerHTML = state.panelCollapsed ? ICONS.expand : ICONS.collapse;
    ui.collapseBtn.title = state.panelCollapsed ? "Expand FaceParty" : "Collapse FaceParty";
    postToHost({ type: "SET_COLLAPSED", collapsed: state.panelCollapsed });
  }

  async function toggleCollapsed() {
    state.panelCollapsed = !state.panelCollapsed;
    await chrome.storage.local.set({ panelCollapsed: state.panelCollapsed });
    applyCollapsedChrome();
  }

  function updateMediaButtons() {
    ui.camBtn.innerHTML = state.camOn ? ICONS.camOn : ICONS.camOff;
    ui.micBtn.innerHTML = state.micOn ? ICONS.micOn : ICONS.micOff;
    ui.camBtn.classList.toggle("is-off", !state.camOn);
    ui.micBtn.classList.toggle("is-off", !state.micOn);
  }

  function setRoomChrome() {
    if (state.roomCode) {
      ui.pill.textContent = `${state.roomCode} · ${peerCount()}`;
      ui.pill.classList.add("is-live");
      ui.empty.hidden = true;
      ui.grid.hidden = false;
      ui.controls.hidden = false;
    } else {
      ui.pill.textContent = state.joining ? "Connecting…" : "Not connected";
      ui.pill.classList.toggle("is-live", state.joining);
      ui.empty.hidden = state.joining;
      ui.grid.hidden = !state.joining;
      ui.controls.hidden = !state.joining;
    }
    updateMediaButtons();
    postToHost({ type: "SESSION", session: sessionSnapshot() });
  }

  // ---------- Media ----------

  function ensureAudioCtx() {
    if (!state.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) state.audioCtx = new Ctx();
    }
    return state.audioCtx;
  }

  function attachAnalyser(stream) {
    try {
      const ctx = ensureAudioCtx();
      if (!ctx || !stream?.getAudioTracks().length) return null;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      return { analyser, data: new Uint8Array(analyser.frequencyBinCount) };
    } catch (err) {
      warn("analyser failed", err);
      return null;
    }
  }

  function startSpeakingLoop() {
    if (state.rafSpeaking) return;
    const tick = () => {
      const entries = [
        ["local", state._localAnalyser, ui.grid.querySelector(".fp-tile.is-local")],
      ];
      for (const [id, peer] of state.peers) {
        entries.push([
          id,
          peer.analyser,
          ui.grid.querySelector(`[data-peer-id="${CSS.escape(id)}"]`),
        ]);
      }
      for (const [, pack, tile] of entries) {
        if (!pack?.analyser || !tile) continue;
        pack.analyser.getByteFrequencyData(pack.data);
        let sum = 0;
        for (let i = 0; i < pack.data.length; i++) sum += pack.data[i];
        tile.classList.toggle("is-speaking", sum / pack.data.length > 18);
      }
      state.rafSpeaking = requestAnimationFrame(tick);
    };
    state.rafSpeaking = requestAnimationFrame(tick);
  }

  /** Black video + silent audio so WebRTC calls still work if the cam is blocked. */
  function createPlaceholderStream() {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#151b24";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "600 28px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Camera off", canvas.width / 2, canvas.height / 2);
    const stream = canvas.captureStream(8);
    // Silent audio track (some peers expect audio m-line).
    try {
      const audioCtx = ensureAudioCtx();
      if (audioCtx) {
        const dest = audioCtx.createMediaStreamDestination();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
        stream._fpOsc = osc;
      }
    } catch (_) {
      /* ignore */
    }
    return stream;
  }

  async function ensureLocalMedia({ requireReal = false } = {}) {
    if (state.localStream && !state.mediaPlaceholder) return state.localStream;
    if (state.localStream && state.mediaPlaceholder && !requireReal) {
      return state.localStream;
    }

    try {
      ensureAudioCtx()?.resume?.();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      // Swap out placeholder if we had one.
      if (state.localStream && state.mediaPlaceholder) {
        state.localStream.getTracks().forEach((t) => t.stop());
      }

      state.localStream = stream;
      state.mediaPlaceholder = false;
      state.camOn = state.camOnByDefault;
      state.micOn = state.micOnByDefault;
      stream.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
      stream.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
      state._localAnalyser = attachAnalyser(stream);
      startSpeakingLoop();
      // Re-call everyone so they receive the real camera track.
      recallAllPeers();
      renderGrid();
      return stream;
    } catch (err) {
      warn("getUserMedia failed", err?.name || err);
      if (requireReal) {
        throw new Error(
          "Camera/mic blocked. Click Allow on the FaceParty prompt, or site settings → Camera."
        );
      }
      if (!state.localStream) {
        state.localStream = createPlaceholderStream();
        state.mediaPlaceholder = true;
        state.camOn = false;
        state.micOn = false;
        toast("Camera blocked — click Enable camera in the panel");
      }
      return state.localStream;
    }
  }

  function stopLocalMedia() {
    try {
      state.localStream?._fpOsc?.stop?.();
    } catch (_) {
      /* ignore */
    }
    state.localStream?.getTracks().forEach((t) => t.stop());
    state.localStream = null;
    state.mediaPlaceholder = false;
    state._localAnalyser = null;
  }

  function toggleCam(force) {
    if (!state.localStream || state.mediaPlaceholder) {
      ensureLocalMedia({ requireReal: true }).catch((e) => toast(e.message));
      return;
    }
    state.camOn = typeof force === "boolean" ? force : !state.camOn;
    state.localStream.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
    broadcastData({ type: "MEDIA_STATE", camOn: state.camOn, micOn: state.micOn });
    renderGrid();
  }

  function toggleMic(force) {
    if (!state.localStream || state.mediaPlaceholder) {
      ensureLocalMedia({ requireReal: true }).catch((e) => toast(e.message));
      return;
    }
    state.micOn = typeof force === "boolean" ? force : !state.micOn;
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
    broadcastData({ type: "MEDIA_STATE", camOn: state.camOn, micOn: state.micOn });
    renderGrid();
  }

  async function copyInvite() {
    if (!state.roomCode) return { ok: false, error: "Not in a room." };
    const link = inviteLink(state.roomCode);
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied");
    } catch {
      toast(link);
    }
    return { ok: true, inviteLink: link, roomCode: state.roomCode };
  }

  // ---------- Tiles ----------

  function renderGrid() {
    const count = Math.min(Math.max(peerCount(), 1), MAX_PEERS);
    ui.grid.dataset.count = String(count);
    ui.grid.innerHTML = "";
    ui.grid.appendChild(
      createTile({
        id: "local",
        name: state.displayName || "You",
        stream: state.localStream,
        isLocal: true,
        camOn: state.camOn,
        micOn: state.micOn,
      })
    );
    for (const [id, peer] of state.peers) {
      ui.grid.appendChild(
        createTile({
          id,
          name: peer.name || "Friend",
          stream: peer.stream,
          isLocal: false,
          camOn: peer.camOn !== false,
          micOn: peer.micOn !== false,
        })
      );
    }
    setRoomChrome();
  }

  function createTile({ id, name, stream, isLocal, camOn, micOn }) {
    const tile = document.createElement("div");
    tile.className = "fp-tile" + (isLocal ? " is-local" : "");
    tile.dataset.peerId = id;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;
    // Always attach stream when we have one (even if "cam off" — track may be disabled).
    if (stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }

    const placeholder = document.createElement("div");
    placeholder.className = "fp-tile__placeholder";

    if (isLocal && state.mediaPlaceholder) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fp-btn fp-btn--accent";
      btn.textContent = "Enable camera";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        ensureLocalMedia({ requireReal: true }).catch((err) => toast(err.message));
      });
      placeholder.appendChild(btn);
    } else {
      placeholder.textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
      // Hide placeholder when we have a live-looking video track enabled.
      placeholder.hidden = Boolean(stream && camOn);
    }

    const label = document.createElement("div");
    label.className = "fp-tile__name";
    label.textContent = isLocal ? `${name} (you)` : name;

    const flags = document.createElement("div");
    flags.className = "fp-tile__flags";
    flags.innerHTML = `
      <span class="fp-flag ${micOn ? "" : "is-on"}" title="Mic off">${ICONS.micOff}</span>
      <span class="fp-flag ${camOn ? "" : "is-on"}" title="Cam off">${ICONS.camOff}</span>
    `;

    tile.append(video, placeholder, label, flags);
    return tile;
  }

  // ---------- PeerJS hub + mesh ----------

  function waitForPeerOpen(peer, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!peer) return reject(new Error("No peer"));
      if (!peer.destroyed && peer.open) return resolve(peer.id);

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Could not reach PeerJS cloud. Check your network / ad blockers."));
      }, timeoutMs);

      const onOpen = (id) => {
        cleanup();
        resolve(id);
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        peer.off("open", onOpen);
        peer.off("error", onError);
      };
      peer.on("open", onOpen);
      peer.on("error", onError);
    });
  }

  function createPeer(id) {
    if (typeof Peer === "undefined") {
      throw new Error("PeerJS failed to load.");
    }
    return new Peer(id, { debug: DEBUG ? 2 : 0 });
  }

  function destroyPeer(peer) {
    try {
      peer?.destroy();
    } catch (_) {
      /* ignore */
    }
  }

  function isHubPeerId(id) {
    return typeof id === "string" && id.endsWith("-hub");
  }

  function getKnownPeerList() {
    return [
      {
        id: state.localPeerId,
        name: state.displayName,
        camOn: state.camOn && !state.mediaPlaceholder,
        micOn: state.micOn && !state.mediaPlaceholder,
      },
      ...[...state.peers.entries()].map(([id, p]) => ({
        id,
        name: p.name,
        camOn: p.camOn !== false,
        micOn: p.micOn !== false,
      })),
    ];
  }

  function startRosterBroadcast() {
    clearInterval(state.rosterTimer);
    if (!state.isHub) return;
    state.rosterTimer = setInterval(() => {
      if (!state.isHub) return;
      // Keep everyone's mesh in sync if a dial was missed.
      broadcastData({ type: "PEER_LIST", peers: getKnownPeerList() });
      if (state.hubPeer) {
        // Also push to anyone currently connected only via hub signaling.
      }
    }, 4000);
  }

  function wireHubPeer(hubPeer) {
    state.hubPeer = hubPeer;
    state.isHub = true;
    log("I am the hub");
    startRosterBroadcast();

    hubPeer.on("connection", (conn) => {
      conn.on("open", () => {
        // Send roster immediately; newcomers also send HELLO.
        try {
          conn.send({ type: "PEER_LIST", peers: getKnownPeerList() });
        } catch (_) {
          /* ignore */
        }

        conn.on("data", (msg) => {
          if (!msg || typeof msg !== "object") return;
          if (msg.type === "HELLO" && msg.peerId) {
            conn.send({ type: "PEER_LIST", peers: getKnownPeerList() });
            ensureMeshPeer(msg.peerId, {
              name: msg.name || "Friend",
              camOn: msg.camOn !== false,
              micOn: msg.micOn !== false,
            });
            broadcastData({
              type: "PEER_JOINED",
              peer: {
                id: msg.peerId,
                name: msg.name || "Friend",
                camOn: msg.camOn !== false,
                micOn: msg.micOn !== false,
              },
            });
          } else if (msg.type === "REQUEST_LIST") {
            conn.send({ type: "PEER_LIST", peers: getKnownPeerList() });
          }
        });
      });
    });

    hubPeer.on("error", (err) => {
      if (err?.type === "unavailable-id") {
        state.isHub = false;
        destroyPeer(state.hubPeer);
        state.hubPeer = null;
        clearInterval(state.rosterTimer);
        return;
      }
      warn("hub error", err?.type || err);
    });

    hubPeer.on("disconnected", () => {
      try {
        hubPeer.reconnect();
      } catch (_) {
        /* ignore */
      }
    });
  }

  async function tryBecomeHub(roomCode) {
    const hubPeer = createPeer(hubIdFor(roomCode));
    try {
      await waitForPeerOpen(hubPeer, 6000);
      wireHubPeer(hubPeer);
      return true;
    } catch (err) {
      destroyPeer(hubPeer);
      log("hub claim failed", err?.type || err?.message);
      state.isHub = false;
      state.hubPeer = null;
      return false;
    }
  }

  /**
   * Connect to the room hub for discovery only.
   * @param {string} roomCode
   * @param {{discoverOnly?: boolean}} opts discoverOnly=true means a failed
   *   attempt must NOT schedule hub re-election (used during initial join).
   */
  function connectToHub(roomCode, { discoverOnly = false } = {}) {
    return new Promise((resolve) => {
      if (!state.myPeer) return resolve(false);
      let settled = false;
      let opened = false;
      const conn = state.myPeer.connect(hubIdFor(roomCode), { reliable: true });

      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };

      const timer = setTimeout(() => {
        if (!opened) {
          try {
            conn.close();
          } catch (_) {
            /* ignore */
          }
        }
        done(false);
      }, HUB_CONNECT_TIMEOUT_MS);

      conn.on("open", () => {
        opened = true;
        state.hubConn = conn;
        conn.send({
          type: "HELLO",
          peerId: state.localPeerId,
          name: state.displayName,
          camOn: state.camOn && !state.mediaPlaceholder,
          micOn: state.micOn && !state.mediaPlaceholder,
        });
      });

      conn.on("data", (msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "PEER_LIST") {
          applyPeerList(msg.peers);
          done(true);
        }
      });

      conn.on("error", () => {
        if (!opened) done(false);
      });

      conn.on("close", () => {
        if (state.hubConn === conn) state.hubConn = null;
        if (!settled) {
          done(false);
          return;
        }
        // Only re-elect after we had a real live hub connection.
        if (!discoverOnly && opened && state.roomCode && !state.isHub) {
          scheduleHubReelection();
        }
      });
    });
  }

  function scheduleHubReelection() {
    if (!state.roomCode || state.isHub) return;
    clearTimeout(state.hubReelectTimer);
    const delay = 250 + Math.floor(Math.random() * HUB_REELECT_JITTER_MS);
    state.hubReelectTimer = setTimeout(async () => {
      if (!state.roomCode || state.isHub) return;
      const connected = await connectToHub(state.roomCode, { discoverOnly: false });
      if (!connected) await tryBecomeHub(state.roomCode);
    }, delay);
  }

  function applyPeerList(peers) {
    for (const p of peers || []) {
      if (!p?.id || p.id === state.localPeerId || isHubPeerId(p.id)) continue;
      ensureMeshPeer(p.id, p);
    }
  }

  function ensurePeerRecord(peerId, meta = {}) {
    if (!peerId || peerId === state.localPeerId || isHubPeerId(peerId)) return null;
    if (state.peers.size >= MAX_PEERS - 1 && !state.peers.has(peerId)) return null;
    let peer = state.peers.get(peerId);
    if (!peer) {
      peer = {
        name: meta.name || "Friend",
        stream: null,
        mediaConn: null,
        dataConn: null,
        camOn: meta.camOn !== false,
        micOn: meta.micOn !== false,
        analyser: null,
        retryTimer: null,
        retries: 0,
        dead: false,
      };
      state.peers.set(peerId, peer);
      renderGrid();
    } else {
      peer.dead = false;
      if (meta.name) peer.name = meta.name;
      if (meta.camOn != null) peer.camOn = meta.camOn;
      if (meta.micOn != null) peer.micOn = meta.micOn;
    }
    return peer;
  }

  function shouldInitiateMedia(remoteId) {
    return state.localPeerId && remoteId && state.localPeerId < remoteId;
  }

  function ensureMeshPeer(peerId, meta = {}) {
    const peer = ensurePeerRecord(peerId, meta);
    if (!peer || !state.myPeer || state.myPeer.destroyed) return;

    // Data: both sides may dial; first open wins. Retries cover peer-unavailable races.
    dialData(peerId);
    // Media: only the lexicographically smaller id dials (avoids call glare).
    if (shouldInitiateMedia(peerId)) dialMedia(peerId);
    scheduleMeshRetry(peerId);
  }

  function scheduleMeshRetry(peerId) {
    const peer = state.peers.get(peerId);
    if (!peer || peer.dead) return;
    clearTimeout(peer.retryTimer);
    if (peer.retries >= MESH_RETRY_MAX) return;

    const dataOk = peer.dataConn?.open;
    const mediaOk = Boolean(peer.stream) || (!shouldInitiateMedia(peerId) && peer.mediaConn);
    if (dataOk && (mediaOk || !state.localStream)) return;

    peer.retryTimer = setTimeout(() => {
      const p = state.peers.get(peerId);
      if (!p || p.dead || !state.roomCode) return;
      p.retries += 1;
      log("retry mesh", peerId, p.retries);
      if (!p.dataConn?.open) dialData(peerId);
      if (shouldInitiateMedia(peerId) && !p.stream) dialMedia(peerId);
      scheduleMeshRetry(peerId);
    }, MESH_RETRY_MS);
  }

  function dialData(peerId) {
    const peer = state.peers.get(peerId);
    if (!peer || !state.myPeer || state.myPeer.destroyed) return;
    if (peer.dataConn?.open) return;
    // Drop a dead half-open connection before redialing.
    if (peer.dataConn && !peer.dataConn.open) {
      try {
        peer.dataConn.close();
      } catch (_) {
        /* ignore */
      }
      peer.dataConn = null;
    }
    try {
      const conn = state.myPeer.connect(peerId, { reliable: true });
      attachDataConn(peerId, conn);
    } catch (err) {
      log("dialData failed", peerId, err?.message || err);
    }
  }

  function dialMedia(peerId) {
    const peer = state.peers.get(peerId);
    if (!peer || !state.myPeer || !state.localStream) return;
    if (peer.stream) return;
    if (peer.mediaConn) {
      try {
        peer.mediaConn.close();
      } catch (_) {
        /* ignore */
      }
      peer.mediaConn = null;
    }
    try {
      const call = state.myPeer.call(peerId, state.localStream, {
        metadata: {
          name: state.displayName,
          camOn: state.camOn && !state.mediaPlaceholder,
          micOn: state.micOn && !state.mediaPlaceholder,
        },
      });
      attachMediaConn(peerId, call);
    } catch (err) {
      log("dialMedia failed", peerId, err?.message || err);
    }
  }

  function recallAllPeers() {
    for (const [peerId, peer] of state.peers) {
      peer.stream = peer.stream; // keep remote
      if (shouldInitiateMedia(peerId)) {
        peer.retries = 0;
        dialMedia(peerId);
        scheduleMeshRetry(peerId);
      }
    }
  }

  function attachDataConn(peerId, conn) {
    const peer = ensurePeerRecord(peerId);
    if (!peer || !conn) return;

    // Prefer an already-open connection if glare created two.
    if (peer.dataConn?.open && peer.dataConn !== conn) {
      try {
        conn.close();
      } catch (_) {
        /* ignore */
      }
      return;
    }

    peer.dataConn = conn;

    conn.on("open", () => {
      peer.retries = 0;
      try {
        conn.send({
          type: "HELLO",
          peerId: state.localPeerId,
          name: state.displayName,
          camOn: state.camOn && !state.mediaPlaceholder,
          micOn: state.micOn && !state.mediaPlaceholder,
        });
      } catch (_) {
        /* ignore */
      }
      if (shouldInitiateMedia(peerId)) dialMedia(peerId);
      renderGrid();
    });

    conn.on("data", (msg) => onPeerData(peerId, msg));

    conn.on("close", () => {
      if (peer.dataConn === conn) peer.dataConn = null;
      // Don't drop the tile immediately — retry, unless peer left cleanly.
      if (!peer.dead && state.roomCode) scheduleMeshRetry(peerId);
    });
  }

  function attachMediaConn(peerId, call) {
    const peer = ensurePeerRecord(peerId, call?.metadata || {});
    if (!peer || !call) {
      try {
        call?.close();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    peer.mediaConn = call;

    call.on("stream", (stream) => {
      peer.stream = stream;
      peer.analyser = attachAnalyser(stream);
      peer.retries = 0;
      startSpeakingLoop();
      renderGrid();
    });

    call.on("close", () => {
      if (peer.mediaConn === call) {
        peer.mediaConn = null;
        peer.stream = null;
        renderGrid();
        if (!peer.dead && state.roomCode && shouldInitiateMedia(peerId)) {
          scheduleMeshRetry(peerId);
        }
      }
    });

    call.on("error", () => {
      if (peer.mediaConn === call) peer.mediaConn = null;
      if (!peer.dead && shouldInitiateMedia(peerId)) scheduleMeshRetry(peerId);
    });
  }

  function onPeerData(fromId, msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "HELLO":
        ensureMeshPeer(fromId, msg);
        break;
      case "PEER_JOINED":
        if (msg.peer?.id && msg.peer.id !== state.localPeerId) {
          ensureMeshPeer(msg.peer.id, msg.peer);
        }
        break;
      case "PEER_LIST":
        applyPeerList(msg.peers);
        break;
      case "PEER_LEFT":
        if (msg.peerId) removePeer(msg.peerId, { permanent: true });
        break;
      case "MEDIA_STATE": {
        const peer = state.peers.get(fromId);
        if (peer) {
          peer.camOn = msg.camOn !== false;
          peer.micOn = msg.micOn !== false;
          renderGrid();
        }
        break;
      }
      case "NAME_UPDATE": {
        const peer = state.peers.get(fromId);
        if (peer && msg.name) {
          peer.name = String(msg.name).slice(0, 24);
          renderGrid();
        }
        break;
      }
      default:
        break;
    }
  }

  function broadcastData(msg) {
    for (const peer of state.peers.values()) {
      if (peer.dataConn?.open) {
        try {
          peer.dataConn.send(msg);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  function removePeer(peerId, { permanent = false } = {}) {
    const peer = state.peers.get(peerId);
    if (!peer) return;
    peer.dead = permanent;
    clearTimeout(peer.retryTimer);
    try {
      peer.mediaConn?.close();
    } catch (_) {
      /* ignore */
    }
    try {
      peer.dataConn?.close();
    } catch (_) {
      /* ignore */
    }
    state.peers.delete(peerId);
    renderGrid();
  }

  function wirePersonalPeer(peer) {
    state.myPeer = peer;
    state.localPeerId = peer.id;

    peer.on("connection", (conn) => {
      // Ignore signaling connections that somehow target us as hub id on personal peer.
      if (isHubPeerId(conn.peer)) return;
      attachDataConn(conn.peer, conn);
    });

    peer.on("call", async (call) => {
      try {
        if (!state.localStream) await ensureLocalMedia();
        call.answer(state.localStream);
        ensurePeerRecord(call.peer, call.metadata || {});
        attachMediaConn(call.peer, call);
        // If we are the media initiator, also make sure our outbound call exists.
        if (shouldInitiateMedia(call.peer)) dialMedia(call.peer);
      } catch (err) {
        warn("answer failed", err);
      }
    });

    peer.on("disconnected", () => {
      try {
        peer.reconnect();
      } catch (_) {
        /* ignore */
      }
    });

    peer.on("error", (err) => {
      // Expected when dialing a peer/hub that is not registered yet.
      if (err?.type === "peer-unavailable") {
        log("peer-unavailable (will retry)", err?.message);
        return;
      }
      warn("peer error", err?.type || err);
    });
  }

  async function joinRoom(roomCode, { created = false } = {}) {
    const code = String(roomCode || "").toLowerCase();
    if (!ROOM_CODE_RE.test(code)) {
      return { ok: false, error: "Room codes are 6 lowercase letters/numbers." };
    }
    if (state.joining) {
      return { ok: false, error: "Already joining…" };
    }
    if (state.roomCode === code && state.myPeer && !state.myPeer.destroyed) {
      return {
        ok: true,
        roomCode: code,
        inviteLink: inviteLink(code),
        session: sessionSnapshot(),
      };
    }

    const epoch = ++state.joinEpoch;
    state.joining = true;
    setRoomChrome();
    toast(created ? "Starting room…" : "Joining…");

    try {
      if (state.roomCode) await leaveRoom({ silent: true, keepStorage: true });
      if (epoch !== state.joinEpoch) return { ok: false, error: "Superseded." };

      // Prefer real camera; fall back to placeholder so signaling still works.
      await ensureLocalMedia({ requireReal: false });
      if (epoch !== state.joinEpoch) return { ok: false, error: "Superseded." };

      const myPeer = createPeer(personalIdFor(code));
      await waitForPeerOpen(myPeer);
      if (epoch !== state.joinEpoch) {
        destroyPeer(myPeer);
        return { ok: false, error: "Superseded." };
      }
      wirePersonalPeer(myPeer);

      state.roomCode = code;
      if (!state.mediaPlaceholder) {
        state.camOn = state.camOnByDefault;
        state.micOn = state.micOnByDefault;
        state.localStream?.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
        state.localStream?.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
      }

      // Discovery timeouts must not trigger hub re-election.
      let reachedHub = await connectToHub(code, { discoverOnly: true });
      if (!reachedHub) {
        const became = await tryBecomeHub(code);
        if (!became) {
          reachedHub = await connectToHub(code, { discoverOnly: false });
        }
      }

      await chrome.storage.local.set({
        activeRoom: { code, joinedAt: Date.now() },
      });

      renderGrid();
      toast(
        state.mediaPlaceholder
          ? `In ${code} — tap Enable camera`
          : created
            ? `Room ${code} ready`
            : `Joined ${code}`
      );
      return {
        ok: true,
        roomCode: code,
        inviteLink: inviteLink(code),
        session: sessionSnapshot(),
      };
    } catch (err) {
      warn("join failed", err);
      await leaveRoom({ silent: true });
      toast(err?.message || "Failed to join");
      return { ok: false, error: err?.message || "Failed to join room." };
    } finally {
      state.joining = false;
      setRoomChrome();
    }
  }

  async function createRoom() {
    return joinRoom(generateRoomCode(), { created: true });
  }

  async function leaveRoom({ silent = false, keepStorage = false } = {}) {
    clearTimeout(state.hubReelectTimer);
    state.hubReelectTimer = null;
    clearInterval(state.rosterTimer);
    state.rosterTimer = null;

    broadcastData({ type: "PEER_LEFT", peerId: state.localPeerId });
    for (const id of [...state.peers.keys()]) {
      removePeer(id, { permanent: true });
    }

    try {
      state.hubConn?.close();
    } catch (_) {
      /* ignore */
    }
    state.hubConn = null;

    destroyPeer(state.hubPeer);
    state.hubPeer = null;
    state.isHub = false;
    destroyPeer(state.myPeer);
    state.myPeer = null;
    state.localPeerId = null;
    stopLocalMedia();
    state.roomCode = null;
    if (!keepStorage) await chrome.storage.local.set({ activeRoom: null });
    ui.grid.innerHTML = "";
    setRoomChrome();
    if (!silent) toast("Left room");
    return { ok: true };
  }

  // ---------- Commands from content-script host / popup ----------

  async function handleCommand(message) {
    switch (message?.type) {
      case "GET_SESSION":
        return { ok: true, session: sessionSnapshot() };
      case "CREATE_ROOM":
        return createRoom();
      case "JOIN_ROOM":
        return joinRoom(message.roomCode);
      case "LEAVE_ROOM":
        return leaveRoom();
      case "COPY_INVITE":
        return copyInvite();
      case "TOGGLE_CAM":
        toggleCam(message.value);
        return { ok: true, camOn: state.camOn };
      case "TOGGLE_MIC":
        toggleMic(message.value);
        return { ok: true, micOn: state.micOn };
      case "SETTINGS_CHANGED": {
        const patch = message.patch || {};
        if (patch.displayName != null) {
          state.displayName = String(patch.displayName).slice(0, 24) || "Guest";
          broadcastData({ type: "NAME_UPDATE", name: state.displayName });
          renderGrid();
        }
        if (patch.camOnByDefault != null) state.camOnByDefault = patch.camOnByDefault;
        if (patch.micOnByDefault != null) state.micOnByDefault = patch.micOnByDefault;
        if (patch.panelCollapsed != null) {
          state.panelCollapsed = Boolean(patch.panelCollapsed);
          applyCollapsedChrome();
        }
        return { ok: true };
      }
      case "PING":
        return { ok: true, ready: true };
      default:
        return { ok: false, error: "Unknown message." };
    }
  }

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || data.target !== "faceparty-panel") return;
    const result = await handleCommand(data);
    postToHost({ type: "COMMAND_RESULT", requestId: data.requestId, result });
  });

  // Also accept runtime messages (useful if ever messaged directly).
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.__facepartyHost) return; // ignore host-only pings
    handleCommand(message).then(sendResponse);
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.activeRoom) {
      const next = changes.activeRoom.newValue;
      if (next?.code && next.code !== state.roomCode && !state.joining) {
        log("storage asked us to join", next.code);
        joinRoom(next.code);
      } else if (!next && state.roomCode) {
        leaveRoom({ silent: true, keepStorage: true });
      }
    }
    if (changes.displayName) {
      state.displayName = (changes.displayName.newValue || "Guest").slice(0, 24);
      broadcastData({ type: "NAME_UPDATE", name: state.displayName });
      renderGrid();
    }
    if (changes.panelCollapsed) {
      state.panelCollapsed = Boolean(changes.panelCollapsed.newValue);
      applyCollapsedChrome();
    }
  });

  // ---------- UI events ----------

  ui.camBtn.addEventListener("click", () => toggleCam());
  ui.micBtn.addEventListener("click", () => toggleMic());
  ui.linkBtn.addEventListener("click", () => copyInvite());
  ui.leaveBtn.addEventListener("click", () => leaveRoom());
  ui.collapseBtn.addEventListener("click", () => toggleCollapsed());
  ui.emptyCreate.addEventListener("click", () => createRoom());
  ui.emptyJoin.addEventListener("click", () => {
    const raw = prompt("Paste a FaceParty room code or invite link:");
    const code = extractRoomCode(raw);
    if (!code) {
      toast("Invalid room code");
      return;
    }
    joinRoom(code);
  });

  ui.camBtn.innerHTML = ICONS.camOn;
  ui.micBtn.innerHTML = ICONS.micOn;
  ui.linkBtn.innerHTML = ICONS.link;
  ui.leaveBtn.innerHTML = ICONS.leave;

  window.addEventListener("beforeunload", () => {
    stopLocalMedia();
    destroyPeer(state.hubPeer);
    destroyPeer(state.myPeer);
  });

  (async function init() {
    const stored = await loadSettings();
    applyCollapsedChrome();
    setRoomChrome();
    postToHost({ type: "READY" });

    if (stored.activeRoom?.code) {
      log("Auto-rejoining", stored.activeRoom.code);
      await joinRoom(stored.activeRoom.code);
    }
  })().catch((err) => warn("init failed", err));
})();
