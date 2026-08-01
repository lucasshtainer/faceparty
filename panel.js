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
  const HUB_CONNECT_TIMEOUT_MS = 2500;
  const HUB_REELECT_JITTER_MS = 900;

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
    hubReelectTimer: null,
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

  async function ensureLocalMedia() {
    if (state.localStream) return state.localStream;
    try {
      ensureAudioCtx()?.resume?.();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      state.localStream = stream;
      state.camOn = state.camOnByDefault;
      state.micOn = state.micOnByDefault;
      stream.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
      stream.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
      state._localAnalyser = attachAnalyser(stream);
      startSpeakingLoop();
      return stream;
    } catch (err) {
      warn("getUserMedia failed", err);
      throw new Error(
        "Camera/mic blocked. Click Allow when prompted (FaceParty needs access). Check the lock icon if you previously denied."
      );
    }
  }

  function stopLocalMedia() {
    state.localStream?.getTracks().forEach((t) => t.stop());
    state.localStream = null;
    state._localAnalyser = null;
  }

  function toggleCam(force) {
    if (!state.localStream) return;
    state.camOn = typeof force === "boolean" ? force : !state.camOn;
    state.localStream.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
    broadcastData({ type: "MEDIA_STATE", camOn: state.camOn, micOn: state.micOn });
    renderGrid();
  }

  function toggleMic(force) {
    if (!state.localStream) return;
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
    if (stream && camOn) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }

    const placeholder = document.createElement("div");
    placeholder.className = "fp-tile__placeholder";
    placeholder.textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
    placeholder.hidden = Boolean(stream && camOn);

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
        // unavailable-id is expected when racing for hub — bubble it up.
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
    // PeerJS rejects IDs with characters outside [A-Za-z0-9 _-].
    return new Peer(id, { debug: DEBUG ? 2 : 0 });
  }

  function destroyPeer(peer) {
    try {
      peer?.destroy();
    } catch (_) {
      /* ignore */
    }
  }

  function getKnownPeerList() {
    return [
      {
        id: state.localPeerId,
        name: state.displayName,
        camOn: state.camOn,
        micOn: state.micOn,
      },
      ...[...state.peers.entries()].map(([id, p]) => ({
        id,
        name: p.name,
        camOn: p.camOn !== false,
        micOn: p.micOn !== false,
      })),
    ];
  }

  function wireHubPeer(hubPeer) {
    state.hubPeer = hubPeer;
    state.isHub = true;
    log("I am the hub");

    hubPeer.on("connection", (conn) => {
      conn.on("open", () => {
        conn.on("data", (msg) => {
          if (!msg || typeof msg !== "object" || msg.type !== "HELLO" || !msg.peerId) return;
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
        });
      });
    });

    hubPeer.on("error", (err) => {
      warn("hub error", err?.type || err);
      if (err?.type === "unavailable-id" || err?.type === "network") {
        state.isHub = false;
        destroyPeer(state.hubPeer);
        state.hubPeer = null;
      }
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

  function connectToHub(roomCode) {
    return new Promise((resolve) => {
      if (!state.myPeer) return resolve(false);
      let settled = false;
      const conn = state.myPeer.connect(hubIdFor(roomCode), { reliable: true });

      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };

      const timer = setTimeout(() => {
        try {
          conn.close();
        } catch (_) {
          /* ignore */
        }
        done(false);
      }, HUB_CONNECT_TIMEOUT_MS);

      conn.on("open", () => {
        conn.send({
          type: "HELLO",
          peerId: state.localPeerId,
          name: state.displayName,
          camOn: state.camOn,
          micOn: state.micOn,
        });
      });

      conn.on("data", async (msg) => {
        if (msg?.type === "PEER_LIST") {
          for (const p of msg.peers || []) {
            if (!p?.id || p.id === state.localPeerId) continue;
            await ensureMeshPeer(p.id, p);
          }
          done(true);
        }
      });

      conn.on("error", () => done(false));
      conn.on("close", () => {
        if (state.roomCode) scheduleHubReelection();
      });
    });
  }

  function scheduleHubReelection() {
    if (!state.roomCode || state.isHub) return;
    clearTimeout(state.hubReelectTimer);
    const delay = 200 + Math.floor(Math.random() * HUB_REELECT_JITTER_MS);
    state.hubReelectTimer = setTimeout(async () => {
      if (!state.roomCode || state.isHub) return;
      const connected = await connectToHub(state.roomCode);
      if (!connected) await tryBecomeHub(state.roomCode);
    }, delay);
  }

  function ensurePeerRecord(peerId, meta = {}) {
    if (peerId === state.localPeerId) return null;
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
      };
      state.peers.set(peerId, peer);
    } else {
      if (meta.name) peer.name = meta.name;
      if (meta.camOn != null) peer.camOn = meta.camOn;
      if (meta.micOn != null) peer.micOn = meta.micOn;
    }
    return peer;
  }

  async function ensureMeshPeer(peerId, meta = {}) {
    const peer = ensurePeerRecord(peerId, meta);
    if (!peer || !state.myPeer) return;

    if (!peer.dataConn || peer.dataConn.open === false) {
      if (state.localPeerId < peerId) {
        attachDataConn(peerId, state.myPeer.connect(peerId, { reliable: true }));
      }
    }

    if (!peer.mediaConn && state.localStream && state.localPeerId < peerId) {
      attachMediaConn(
        peerId,
        state.myPeer.call(peerId, state.localStream, {
          metadata: {
            name: state.displayName,
            camOn: state.camOn,
            micOn: state.micOn,
          },
        })
      );
    }
    renderGrid();
  }

  function attachDataConn(peerId, conn) {
    const peer = ensurePeerRecord(peerId);
    if (!peer) return;
    peer.dataConn = conn;
    conn.on("open", () => {
      conn.send({
        type: "HELLO",
        peerId: state.localPeerId,
        name: state.displayName,
        camOn: state.camOn,
        micOn: state.micOn,
      });
    });
    conn.on("data", (msg) => onPeerData(peerId, msg));
    conn.on("close", () => removePeer(peerId));
  }

  function attachMediaConn(peerId, call) {
    const peer = ensurePeerRecord(peerId, call.metadata || {});
    if (!peer) {
      try {
        call.close();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    peer.mediaConn = call;
    call.on("stream", (stream) => {
      peer.stream = stream;
      peer.analyser = attachAnalyser(stream);
      startSpeakingLoop();
      renderGrid();
    });
    call.on("close", () => {
      peer.mediaConn = null;
      peer.stream = null;
      renderGrid();
    });
  }

  function onPeerData(fromId, msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "HELLO":
        ensurePeerRecord(fromId, msg);
        if (state.localStream && state.localPeerId < fromId) ensureMeshPeer(fromId, msg);
        renderGrid();
        break;
      case "PEER_JOINED":
        if (msg.peer?.id && msg.peer.id !== state.localPeerId) {
          ensureMeshPeer(msg.peer.id, msg.peer);
        }
        break;
      case "PEER_LEFT":
        if (msg.peerId) removePeer(msg.peerId);
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

  function removePeer(peerId) {
    const peer = state.peers.get(peerId);
    if (!peer) return;
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
      const remoteId = conn.peer;
      attachDataConn(remoteId, conn);
      conn.on("open", () => {
        if (
          state.localStream &&
          state.localPeerId < remoteId &&
          !state.peers.get(remoteId)?.mediaConn
        ) {
          attachMediaConn(
            remoteId,
            state.myPeer.call(remoteId, state.localStream, {
              metadata: {
                name: state.displayName,
                camOn: state.camOn,
                micOn: state.micOn,
              },
            })
          );
        }
      });
    });

    peer.on("call", async (call) => {
      try {
        if (!state.localStream) await ensureLocalMedia();
        call.answer(state.localStream);
        attachMediaConn(call.peer, call);
        ensurePeerRecord(call.peer, call.metadata || {});
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

    peer.on("error", (err) => warn("peer error", err?.type || err));
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

    state.joining = true;
    setRoomChrome();
    toast(created ? "Starting room…" : "Joining…");

    try {
      if (state.roomCode) await leaveRoom({ silent: true, keepStorage: true });

      await ensureLocalMedia();

      const myPeer = createPeer(personalIdFor(code));
      await waitForPeerOpen(myPeer);
      wirePersonalPeer(myPeer);

      state.roomCode = code;
      state.camOn = state.camOnByDefault;
      state.micOn = state.micOnByDefault;
      state.localStream?.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
      state.localStream?.getAudioTracks().forEach((t) => (t.enabled = state.micOn));

      const reachedHub = await connectToHub(code);
      if (!reachedHub) {
        const became = await tryBecomeHub(code);
        if (!became) await connectToHub(code);
      }

      await chrome.storage.local.set({
        activeRoom: { code, joinedAt: Date.now() },
      });

      renderGrid();
      toast(created ? `Room ${code} ready` : `Joined ${code}`);
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
    broadcastData({ type: "PEER_LEFT", peerId: state.localPeerId });
    for (const id of [...state.peers.keys()]) removePeer(id);
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
