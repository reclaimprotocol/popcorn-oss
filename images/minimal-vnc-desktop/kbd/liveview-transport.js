// Shared LiveView transport switch. The viewer and all of its keyboard/touch
// behavior stay identical; only the wire used for RFB and control changes.
// No `encryption` query parameter means the default transport. The client must
// explicitly request `?encryption=e2e` and install an E2E client bootstrap.

const decoder = new TextDecoder();
const E2E = new URLSearchParams(window.location.search).get('encryption') === 'e2e';

let configureResolve;
const configured = new Promise((resolve) => { configureResolve = resolve; });

function bytesToText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return decoder.decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return decoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  throw new TypeError('control frame must be text or bytes');
}

function bodyJSON(options) {
  if (!options || options.body == null || options.body === '') return {};
  return typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
}

function response(value, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => value };
}

class VirtualSocket {
  constructor(manager, kind) {
    this.manager = manager;
    this.kind = kind;
    this.readyState = WebSocket.CONNECTING;
    this.binaryType = '';
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
  }
  send(value) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('control transport is not open');
    this.manager.sendFrom(this.kind, value);
  }
  close(code = 1000, reason = '') {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    this.manager.close(code, reason);
  }
}

class EncryptedControlManager {
  constructor(connect, mirror) {
    if (typeof connect !== 'function') throw new TypeError('encrypted control connector is required');
    this.connect = connect;
    this.mirror = !!mirror;
    this.channel = null;
    this.connecting = null;
    this.views = new Set();
    this.outbox = [];
    this.last = { geometry: null, signal: null, dialog: null, popup: null };
    this.geometryWaiters = [];
  }

  open(kind) {
    if (kind !== 'signal' && kind !== 'input') throw new TypeError('unknown control socket kind');
    const view = new VirtualSocket(this, kind);
    this.views.add(view);
    this.ensureConnected();
    return view;
  }

  ensureConnected() {
    if (this.channel && this.channel.readyState === WebSocket.OPEN) {
      this.openViews();
      return Promise.resolve(this.channel);
    }
    if (this.connecting) return this.connecting;
    this.connecting = Promise.resolve().then(() => this.connect()).then((channel) => {
      this.connecting = null;
      this.channel = channel;
      channel.onmessage = (event) => this.receive(event.data);
      channel.onclose = (event) => this.down(event || {});
      channel.onerror = (event) => this.down(event || {});
      this.sendEnvelope('hello', { mirror: this.mirror }, false);
      const queued = this.outbox;
      this.outbox = [];
      for (const item of queued) this.sendEnvelope(item.type, item.payload, false);
      this.openViews();
      return channel;
    }).catch((error) => {
      this.connecting = null;
      this.down({ error });
      throw error;
    });
    // Socket owners observe the failure through onerror/onclose and own retry.
    this.connecting.catch(() => {});
    return this.connecting;
  }

  openViews() {
    for (const view of this.views) {
      if (view.readyState !== WebSocket.CONNECTING) continue;
      view.readyState = WebSocket.OPEN;
      queueMicrotask(() => { if (view.readyState === WebSocket.OPEN) view.onopen?.({}); });
    }
  }

  down(event) {
    const views = [...this.views];
    this.views.clear();
    this.channel = null;
    for (const view of views) {
      if (view.readyState === WebSocket.CLOSED) continue;
      view.readyState = WebSocket.CLOSED;
      try { view.onerror?.(event); } catch (_) {}
      try { view.onclose?.(event); } catch (_) {}
    }
  }

  close(code, reason) {
    const channel = this.channel;
    if (channel && channel.readyState < WebSocket.CLOSING) {
      try { channel.close(code, reason); } catch (_) {}
    } else {
      this.down({ code, reason });
    }
  }

  sendEnvelope(type, payload, queue = true) {
    if (!this.channel || this.channel.readyState !== WebSocket.OPEN) {
      if (queue) {
        this.outbox.push({ type, payload });
        while (this.outbox.length > 64) this.outbox.shift();
        this.ensureConnected();
        return true;
      }
      return false;
    }
    this.channel.send(JSON.stringify({ type, payload }));
    return true;
  }

  sendFrom(kind, value) {
    const message = JSON.parse(bytesToText(value));
    if (kind === 'input') {
      const payload = { ...message };
      if (payload.d != null) { payload.sid = payload.d; delete payload.d; }
      if (payload.g != null) { payload.gesture = payload.g; delete payload.g; }
      this.sendEnvelope('touch', payload);
      return;
    }
    if (message.t === 'ping') { this.sendEnvelope('ping', { id: message.id }); return; }
    if (message.mirror) { this.sendEnvelope('mirror', { on: !!message.mirror.on }); return; }
    if (message.dialogReply) { this.sendEnvelope('dialog-reply', message.dialogReply); return; }
    if (message.popupClose) { this.sendEnvelope('popup-close', message.popupClose); return; }
    // A choice made in a local native control. The wrapper stays on so the pod can
    // hand the payload to the same canonicalizing relay the /kbd path uses.
    if (message.selectChoice) { this.sendEnvelope('select-choice', { selectChoice: message.selectChoice }); return; }
    if (message.pickerChoice) { this.sendEnvelope('picker-choice', { pickerChoice: message.pickerChoice }); return; }
    throw new TypeError('unsupported encrypted control message');
  }

  deliver(kind, value) {
    const data = JSON.stringify(value);
    for (const view of this.views) {
      if (view.kind === kind && view.readyState === WebSocket.OPEN) view.onmessage?.({ data });
    }
  }

  receive(value) {
    let envelope;
    try { envelope = JSON.parse(bytesToText(value)); } catch (_) { this.close(1008, 'invalid control envelope'); return; }
    const { type, payload } = envelope || {};
    if (type === 'signal') {
      // Command acknowledgements are not keyboard state and must not be fed into
      // the state machine (which would interpret them as editable=false).
      if (payload && Object.keys(payload).length === 1 && payload.ack) return;
      this.last.signal = payload;
      this.deliver('signal', payload);
    } else if (type === 'dialog') {
      this.last.dialog = payload; this.deliver('signal', { dialog: payload });
    } else if (type === 'popup') {
      this.last.popup = payload; this.deliver('signal', { popup: payload });
    } else if (type === 'pong') {
      this.deliver('signal', { t: 'ping', id: payload && payload.id });
    } else if (type === 'input-ack') {
      this.deliver('input', { diag: 'input', sid: payload && payload.sid, g: payload && payload.gesture,
        t: payload && payload.event, state: payload && payload.state });
    } else if (type === 'geometry') {
      this.last.geometry = payload;
      const waiters = this.geometryWaiters.splice(0);
      for (const resolve of waiters) resolve(payload);
    }
  }

  async geometry() {
    if (this.last.geometry) return this.last.geometry;
    this.ensureConnected();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2500);
      this.geometryWaiters.push((value) => { clearTimeout(timer); resolve(value); });
    });
  }
}

let encryptedControl = null;

export function encryptedTransportRequested() { return E2E; }

export function configureEncryptedControl(connectControl, { mirror = false } = {}) {
  if (!E2E) throw new Error('encrypted transport was not selected');
  if (encryptedControl) return encryptedControl;
  encryptedControl = new EncryptedControlManager(connectControl, mirror);
  configureResolve(encryptedControl);
  return encryptedControl;
}

export function openViewerSocket(url) {
  if (!E2E) return new WebSocket(url);
  const kind = String(url).endsWith('/input') ? 'input' : 'signal';
  if (!encryptedControl) throw new Error('encrypted control is not configured');
  return encryptedControl.open(kind);
}

export async function viewerFetch(url, options) {
  if (!E2E) {
    if (typeof window.fetch !== 'function') throw new Error('fetch unavailable');
    return window.fetch(url, options);
  }
  const manager = await configured;
  const path = String(url).split('?')[0];
  if (path.endsWith('/geometry')) {
    const geometry = await manager.geometry();
    return response(geometry, !!geometry);
  }
  if (path.endsWith('/kbdstate')) return response({ state: manager.last.signal, dialog: manager.last.dialog, popup: manager.last.popup });
  if (path.endsWith('/emulate')) { manager.sendEnvelope('emulate', bodyJSON(options)); return response({}); }
  if (path.endsWith('/klog')) { manager.sendEnvelope('diag', bodyJSON(options)); return response({}); }
  if (path.endsWith('/rtstats')) { manager.sendEnvelope('rtt', bodyJSON(options)); return response({}); }
  throw new Error('unsupported encrypted viewer request');
}

export function viewerSendBeacon(url, body) {
  if (!E2E) return !!(navigator.sendBeacon && navigator.sendBeacon(url, body));
  if (!encryptedControl) return false;
  try {
    const path = String(url).split('?')[0];
    const parse = async () => {
      const text = typeof body === 'string' ? body : await body.text();
      encryptedControl.sendEnvelope(path.endsWith('/rtstats') ? 'rtt' : 'diag', JSON.parse(text));
    };
    parse().catch(() => {});
    return true;
  } catch (_) { return false; }
}
