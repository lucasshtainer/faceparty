/**
 * FaceParty — toolbar popup
 *
 * Lets you set a display name, create/join rooms, and copy invite links.
 * Heavy lifting (WebRTC, DOM docking) happens in content.js on the page.
 */

const $ = (id) => document.getElementById(id);

const els = {
  name: $("fp-name"),
  camDefault: $("fp-cam-default"),
  micDefault: $("fp-mic-default"),
  join: $("fp-join"),
  joinBtn: $("fp-join-btn"),
  createBtn: $("fp-create-btn"),
  copyBtn: $("fp-copy-btn"),
  leaveBtn: $("fp-leave-btn"),
  status: $("fp-status"),
  roomInfo: $("fp-room-info"),
  roomCode: $("fp-room-code"),
  peerCount: $("fp-peer-count"),
  toast: $("fp-toast"),
};

let toastTimer = null;

function showToast(message, isError = false) {
  els.toast.hidden = false;
  els.toast.textContent = message;
  els.toast.classList.toggle("is-error", isError);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2800);
}

/**
 * Extract a 6-char room code from raw text or an invite URL.
 * Supports: "abcd12", "#room=abcd12", "https://faceparty.link/#room=abcd12"
 */
function extractRoomCode(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const hashMatch = text.match(/[#&?]room=([a-z0-9]{6})/i);
  if (hashMatch) return hashMatch[1].toLowerCase();

  const bare = text.match(/\b([a-z0-9]{6})\b/i);
  if (bare) return bare[1].toLowerCase();

  return null;
}

function inviteLinkFor(code) {
  return `https://faceparty.link/#room=${code}`;
}

async function send(type, extra = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...extra });
  } catch (err) {
    return { ok: false, error: err?.message || "Extension messaging failed." };
  }
}

function renderSession(session, state) {
  const inRoom = Boolean(session?.roomCode);
  els.status.textContent = inRoom ? "In room" : "Idle";
  els.status.classList.toggle("is-live", inRoom);
  els.copyBtn.disabled = !inRoom;
  els.leaveBtn.disabled = !inRoom;
  els.roomInfo.hidden = !inRoom;

  if (inRoom) {
    els.roomCode.textContent = session.roomCode;
    const n = session.peerCount || 1;
    els.peerCount.textContent = n === 1 ? "1 person" : `${n} people`;
  }

  if (state?.displayName != null) els.name.value = state.displayName;
  if (state?.camOnByDefault != null) els.camDefault.checked = state.camOnByDefault;
  if (state?.micOnByDefault != null) els.micDefault.checked = state.micOnByDefault;
}

async function refresh() {
  const stateRes = await send("GET_STATE");
  const sessionRes = await send("GET_SESSION");
  renderSession(sessionRes?.ok ? sessionRes.session : null, stateRes?.state);
}

async function persistSettings() {
  await send("SET_STATE", {
    patch: {
      displayName: (els.name.value || "Guest").trim().slice(0, 24) || "Guest",
      camOnByDefault: els.camDefault.checked,
      micOnByDefault: els.micDefault.checked,
    },
  });
}

els.name.addEventListener("change", persistSettings);
els.camDefault.addEventListener("change", persistSettings);
els.micDefault.addEventListener("change", persistSettings);

els.createBtn.addEventListener("click", async () => {
  await persistSettings();
  els.createBtn.disabled = true;
  const res = await send("CREATE_ROOM");
  els.createBtn.disabled = false;

  if (!res?.ok) {
    showToast(res?.error || "Could not create room.", true);
    return;
  }

  if (res.inviteLink) {
    try {
      await navigator.clipboard.writeText(res.inviteLink);
      showToast(
        res.joinWarning
          ? `Link copied. On Netflix: allow camera when prompted.`
          : "Room created — invite link copied!"
      );
    } catch {
      showToast(`Room ${res.roomCode} created. Use Copy invite link.`);
    }
  }

  if (res.joinWarning) {
    // Room exists; tab may still be connecting / waiting for camera allow.
    console.warn("[FaceParty]", res.joinWarning);
  }
  await refresh();
});

els.joinBtn.addEventListener("click", async () => {
  const code = extractRoomCode(els.join.value);
  if (!code) {
    showToast("Enter a 6-character room code or invite link.", true);
    return;
  }
  await persistSettings();
  els.joinBtn.disabled = true;
  const res = await send("JOIN_ROOM", { roomCode: code });
  els.joinBtn.disabled = false;

  if (!res?.ok) {
    showToast(res?.error || "Could not join room.", true);
    return;
  }
  showToast(`Joined room ${code}`);
  await refresh();
});

els.join.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.joinBtn.click();
});

els.copyBtn.addEventListener("click", async () => {
  const res = await send("COPY_INVITE");
  if (!res?.ok) {
    showToast(res?.error || "Nothing to copy.", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(res.inviteLink || inviteLinkFor(res.roomCode));
    showToast("Invite link copied!");
  } catch {
    showToast(res.inviteLink || inviteLinkFor(res.roomCode));
  }
});

els.leaveBtn.addEventListener("click", async () => {
  const res = await send("LEAVE_ROOM");
  if (!res?.ok) {
    showToast(res?.error || "Could not leave.", true);
    return;
  }
  showToast("Left the room.");
  await refresh();
});

// Prefill join field if the user somehow opened a faceparty link in the address bar
// of a supported site (hash is readable by the content script; popup just helps).
refresh();
