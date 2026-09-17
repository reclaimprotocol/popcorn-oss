// Android session live view. The gateway has already authenticated whoever is
// reading this, so there is no token here and nothing to authorise.

const $ = (id) => document.getElementById(id);
const els = {
  canvas: $("screen"),
  overlay: $("overlay"),
  ime: $("ime"),
};

// The device's own status and navigation bars are chrome, not content: a
// session view wants the app. They are cropped out of the frame rather than
// hidden on the device, because `policy_control` is a no-op on Android 14 and
// touching device settings for a cosmetic reason is the wrong trade. `?bars=1`
// keeps them.
const showBars = new URLSearchParams(location.search).get("bars") === "1";

/** Region of the encoded frame actually drawn, in frame pixels. Recomputed
 *  whenever geometry arrives, because insets move with rotation. */
let crop = null;

function updateCrop() {
  if (showBars || !geometry?.insets) {
    crop = null;
    return;
  }
  const { width, height, encodedWidth, encodedHeight, insets } = geometry;
  // Insets are display pixels; the encoded frame is the display scaled down.
  const sx = encodedWidth / width;
  const sy = encodedHeight / height;
  const x = Math.round(insets.left * sx);
  const y = Math.round(insets.top * sy);
  const w = Math.round(encodedWidth - (insets.left + insets.right) * sx);
  const h = Math.round(encodedHeight - (insets.top + insets.bottom) * sy);
  crop = w > 0 && h > 0 ? { x, y, w, h } : null;
}

const ctx = els.canvas.getContext("2d", { alpha: false, desynchronized: true });
let decoder = null;
let decoderCodec = null;
let timestamp = 0;
let sawFirstFrame = false;
let geometry = null;
let readOnly = false;

// ---------------------------------------------------------------- decoding

function splitAnnexB(bytes) {
  const nals = [];
  let start = -1;
  for (let i = 0; i + 2 < bytes.length; i++) {
    const three = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
    const four = three ? false : bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1;
    if (!three && !four) continue;
    const header = four ? 4 : 3;
    if (start >= 0) nals.push(bytes.subarray(start, i));
    start = i + header;
    i += header - 1;
  }
  if (start >= 0) nals.push(bytes.subarray(start));
  return nals;
}

/** WebCodecs needs profile/constraints/level, and only the SPS knows what the
 *  device's encoder actually chose. */
function codecFrom(bytes) {
  for (const nal of splitAnnexB(bytes)) {
    if ((nal[0] & 0x1f) === 7 && nal.length >= 4) {
      const hex = (n) => n.toString(16).padStart(2, "0");
      return `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`;
    }
  }
  return "avc1.42e01e";
}

function ensureDecoder(codec) {
  if (decoder && decoderCodec === codec && decoder.state === "configured") return;
  if (decoder && decoder.state !== "closed") {
    try { decoder.close(); } catch { /* already gone */ }
  }
  decoder = new VideoDecoder({
    output: (frame) => {
      const region = crop ?? { x: 0, y: 0, w: frame.displayWidth, h: frame.displayHeight };
      if (els.canvas.width !== region.w || els.canvas.height !== region.h) {
        els.canvas.width = region.w;
        els.canvas.height = region.h;
      }
      ctx.drawImage(frame, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
      frame.close();
      if (!sawFirstFrame) {
        sawFirstFrame = true;
        els.overlay.hidden = true;
      }
    },
    error: () => { decoder = null; decoderCodec = null; },
  });
  decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "no-preference" });
  decoderCodec = codec;
}

function onVideo(buffer) {
  const bytes = new Uint8Array(buffer);
  const flags = bytes[0];
  const payload = bytes.subarray(1);
  const keyframe = (flags & 1) !== 0;

  if ((flags & 2) !== 0) {
    ensureDecoder(codecFrom(payload));
    return;
  }
  if (!decoder || decoder.state !== "configured") {
    if (!keyframe) return;
    ensureDecoder(codecFrom(payload));
  }
  if (!decoder || decoder.state !== "configured") return;
  if (!sawFirstFrame && !keyframe && decoder.decodeQueueSize === 0) return;

  try {
    decoder.decode(new EncodedVideoChunk({
      type: keyframe ? "key" : "delta",
      timestamp: (timestamp += 16_666),
      data: payload,
    }));
  } catch {
    decoder = null;
  }
}

// ------------------------------------------------------------- connection

let socket = null;

/** Where to reach the session socket.
 *
 *  Served directly, that is `/ws`. Through Popcorn's gateway the page lives at
 *  `/liveview/<session>/<token>/liveview.html` and the socket at
 *  `/liveview-ws/<session>/<token>`, so the path the page was served from is
 *  what says which. */
function socketUrl() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const viaGateway = location.pathname.match(/^\/liveview\/([^/]+)\/([^/]+)/);
  const path = viaGateway ? `/liveview-ws/${viaGateway[1]}/${viaGateway[2]}` : "/ws";
  return `${scheme}://${location.host}${path}`;
}

function connect() {
  socket = new WebSocket(socketUrl());
  socket.binaryType = "arraybuffer";

  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) return onVideo(event.data);
    const message = JSON.parse(event.data);
    if (message.type === "hello") {
      readOnly = !!message.readOnly;
      geometry = message.geometry ?? geometry;
      updateCrop();
      els.canvas.classList.toggle("readonly", readOnly);
    }
    if (message.type === "geometry") {
      geometry = message.geometry;
      updateCrop();
    }
  });

  socket.addEventListener("close", () => {
    els.overlay.hidden = false;
    els.overlay.querySelector("span").textContent = "reconnecting…";
    sawFirstFrame = false;
    setTimeout(connect, 1500);
  });
}

function send(message) {
  if (!readOnly && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// ------------------------------------------------------------------ input

function normalise(event) {
  const rect = els.canvas.getBoundingClientRect();
  const fx = (event.clientX - rect.left) / rect.width;
  const fy = (event.clientY - rect.top) / rect.height;
  if (!crop || !geometry) return { x: fx, y: fy };
  // The canvas is only the cropped window onto the frame, while the server
  // addresses the whole display, so the point goes back into full-frame space.
  return {
    x: (crop.x + fx * crop.w) / geometry.encodedWidth,
    y: (crop.y + fy * crop.h) / geometry.encodedHeight,
  };
}

let pointerStart = null;

els.canvas.addEventListener("pointerdown", (event) => {
  els.ime.focus({ preventScroll: true });
  if (readOnly) return;
  els.canvas.setPointerCapture(event.pointerId);
  pointerStart = { ...normalise(event), at: performance.now() };
});

els.canvas.addEventListener("pointerup", (event) => {
  if (!pointerStart) return;
  const end = normalise(event);
  const duration = performance.now() - pointerStart.at;
  const moved = Math.hypot(end.x - pointerStart.x, end.y - pointerStart.y);
  // A short, near-stationary press is a tap; the real duration is kept for
  // everything else so long-press and fling both land as meant.
  if (moved < 0.012 && duration < 400) {
    send({ type: "tap", x: end.x, y: end.y });
  } else {
    send({
      type: "swipe",
      x1: pointerStart.x, y1: pointerStart.y,
      x2: end.x, y2: end.y,
      duration: Math.round(Math.min(2000, Math.max(40, duration))),
    });
  }
  pointerStart = null;
});

els.canvas.addEventListener("pointercancel", () => { pointerStart = null; });
els.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

els.canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const point = normalise(event);
  const travel = Math.max(-0.4, Math.min(0.4, -event.deltaY / 800));
  if (Math.abs(travel) < 0.01) return;
  send({
    type: "swipe",
    x1: point.x, y1: point.y,
    x2: point.x, y2: Math.min(0.98, Math.max(0.02, point.y + travel)),
    duration: 60,
  });
}, { passive: false });

const NAMED_KEYS = {
  Enter: "enter", Backspace: "backspace", Tab: "tab", Escape: "escape",
  ArrowUp: "dpadUp", ArrowDown: "dpadDown", ArrowLeft: "dpadLeft", ArrowRight: "dpadRight",
};

// Typing is coalesced: `input text` costs ~100ms on the device, so a burst of
// keys should be one call rather than one per key.
let textBuffer = "";
let textTimer = null;

for (const target of [els.canvas, els.ime]) {
  target.addEventListener("keydown", (event) => {
    if (readOnly || event.metaKey || event.ctrlKey || event.altKey) return;
    const named = NAMED_KEYS[event.key];
    if (named) {
      event.preventDefault();
      send({ type: "key", name: named });
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      textBuffer += event.key;
      clearTimeout(textTimer);
      textTimer = setTimeout(() => {
        const value = textBuffer;
        textBuffer = "";
        if (value) send({ type: "text", value });
      }, 45);
    }
  });
}

connect();
