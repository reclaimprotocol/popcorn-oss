// Android session live view. The gateway has already authenticated whoever is
// reading this, so there is no token here and nothing to authorise.

const $ = (id) => document.getElementById(id);
const els = {
  canvas: $("screen"),
  overlay: $("overlay"),
  ime: $("ime"),
};

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
      if (els.canvas.width !== frame.displayWidth || els.canvas.height !== frame.displayHeight) {
        els.canvas.width = frame.displayWidth;
        els.canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
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

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/ws`);
  socket.binaryType = "arraybuffer";

  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) return onVideo(event.data);
    const message = JSON.parse(event.data);
    if (message.type === "hello") {
      readOnly = !!message.readOnly;
      geometry = message.geometry ?? geometry;
      els.canvas.classList.toggle("readonly", readOnly);
    }
    if (message.type === "geometry") geometry = message.geometry;
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
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
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
