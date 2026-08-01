/**
 * Top-level extension page used ONLY to obtain camera/mic permission.
 *
 * Why this exists:
 * - getUserMedia from an iframe embedded in Netflix often fails with
 *   NotAllowedError / "Failed due to shutdown" until the extension itself
 *   has been granted permission from a real extension page + user gesture.
 * - The toolbar popup also closes when the permission dialog opens, which
 *   aborts the request. A dedicated window stays open.
 */

const btn = document.getElementById("allow");
const status = document.getElementById("status");

function setStatus(text, kind) {
  status.textContent = text;
  status.className = kind || "";
}

async function requestMedia() {
  btn.disabled = true;
  setStatus("Waiting for Chrome’s Allow prompt…");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    // We only needed the permission grant — release hardware immediately.
    stream.getTracks().forEach((t) => t.stop());

    await chrome.storage.local.set({
      mediaPermissionGranted: true,
      mediaPermissionAt: Date.now(),
    });

    // Notify any listening panel/background that permission is ready.
    try {
      await chrome.runtime.sendMessage({ type: "MEDIA_PERMISSION_GRANTED" });
    } catch (_) {
      /* no listeners is fine */
    }

    setStatus("Allowed! You can close this window — returning to Netflix…", "ok");
    setTimeout(() => window.close(), 900);
  } catch (err) {
    console.warn("[FaceParty] permission failed", err);
    btn.disabled = false;

    const name = err?.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      setStatus(
        "Permission blocked. Click the camera icon in the address bar → Allow, then try again.",
        "err"
      );
      // Deep-link to this extension’s site settings when possible.
      try {
        const extUrl = `chrome://settings/content/siteDetails?site=${encodeURIComponent(
          `chrome-extension://${chrome.runtime.id}/`
        )}`;
        // chrome:// URLs can't always be opened from pages; show as text too.
        setStatus(
          `Permission blocked. Allow FaceParty under Camera settings, then click again. (${extUrl})`,
          "err"
        );
      } catch (_) {
        /* ignore */
      }
    } else if (name === "NotFoundError") {
      setStatus("No camera/microphone found on this device.", "err");
    } else {
      setStatus(err?.message || "Could not access camera.", "err");
    }
  }
}

btn.addEventListener("click", requestMedia);

// Auto-focus the button so Enter works.
btn.focus();
