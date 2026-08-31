import test from 'node:test';
import assert from 'node:assert/strict';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
}

class FakeControlChannel {
  constructor() { this.readyState = FakeWebSocket.OPEN; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code, reason) { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code, reason }); }
  receive(type, payload) {
    const bytes = new TextEncoder().encode(JSON.stringify({ type, payload }));
    this.onmessage?.({ data: bytes.buffer });
  }
}

test('one viewer maps its existing controls onto the optional E2E transport', async () => {
  const oldWindow = globalThis.window;
  const oldLocation = globalThis.location;
  const oldNavigator = globalThis.navigator;
  const oldWebSocket = globalThis.WebSocket;
  globalThis.window = globalThis;
  globalThis.location = { search: '?encryption=e2e', pathname: '/liveview/s/token/liveview.html' };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { sendBeacon: null } });
  globalThis.WebSocket = FakeWebSocket;
  try {
    const transport = await import(`../liveview-transport.js?test=${Date.now()}`);
    const channel = new FakeControlChannel();
    let connects = 0;
    transport.configureEncryptedControl(async () => { connects++; return channel; }, { mirror: true });

    const signal = transport.openViewerSocket('wss://gateway.example/kbd');
    const input = transport.openViewerSocket('wss://gateway.example/input');
    const signalMessages = [], inputMessages = [];
    signal.onmessage = (event) => signalMessages.push(JSON.parse(event.data));
    input.onmessage = (event) => inputMessages.push(JSON.parse(event.data));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(connects, 1, 'RFB-side keyboard and touch share one encrypted control channel');
    assert.equal(signal.readyState, FakeWebSocket.OPEN);
    assert.equal(input.readyState, FakeWebSocket.OPEN);
    assert.deepEqual(channel.sent[0], { type: 'hello', payload: { mirror: true } });

    signal.send(JSON.stringify({ t: 'ping', id: 7 }));
    signal.send(JSON.stringify({ dialogReply: { seq: 3, accept: true } }));
    input.send(JSON.stringify({ t: 'end', points: [{ x: 1, y: 2 }], d: 'sid', g: 9 }));
    // Choices made in the viewer's local native controls: the wrapper stays on,
    // because the pod feeds the payload to the same relay the /kbd path uses.
    signal.send(JSON.stringify({ selectChoice: { key: 'abc:7', index: 2 } }));
    signal.send(JSON.stringify({ pickerChoice: { key: 'abc:7', value: '2001-02-03' } }));
    assert.deepEqual(channel.sent.slice(1), [
      { type: 'ping', payload: { id: 7 } },
      { type: 'dialog-reply', payload: { seq: 3, accept: true } },
      { type: 'touch', payload: { t: 'end', points: [{ x: 1, y: 2 }], sid: 'sid', gesture: 9 } },
      { type: 'select-choice', payload: { selectChoice: { key: 'abc:7', index: 2 } } },
      { type: 'picker-choice', payload: { pickerChoice: { key: 'abc:7', value: '2001-02-03' } } },
    ]);

    channel.receive('signal', { editable: true });
    channel.receive('signal', { ack: 'hello' });
    channel.receive('pong', { id: 7 });
    channel.receive('input-ack', { sid: 'sid', gesture: 9, event: 'end', state: 'written' });
    assert.deepEqual(signalMessages, [{ editable: true }, { t: 'ping', id: 7 }]);
    assert.deepEqual(inputMessages, [{ diag: 'input', sid: 'sid', g: 9, t: 'end', state: 'written' }]);

    channel.receive('geometry', { width: 1280, height: 720 });
    const geometry = await (await transport.viewerFetch('/geometry')).json();
    assert.deepEqual(geometry, { width: 1280, height: 720 });

    await transport.viewerFetch('/emulate', { body: JSON.stringify({ width: 390, height: 844 }) });
    assert.deepEqual(channel.sent.at(-1), { type: 'emulate', payload: { width: 390, height: 844 } });
  } finally {
    globalThis.window = oldWindow;
    globalThis.location = oldLocation;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: oldNavigator });
    globalThis.WebSocket = oldWebSocket;
  }
});

// The pod names the state in the envelope's `type`, so the payload it carries is
// the BARE dialog/popup state. The viewer adds the key back exactly once — the
// same frame the plain /kbd socket delivers — because signal.js routes on that key
// and unwraps a single level. When the pod cached the already-wrapped form, this
// arrived as {dialog:{dialog:{…}}}: the sheet read open:undefined, tore itself
// down, and no dialog, popup or FedCM chooser was ever drawn under e2e.
test('a dialog envelope reaches the sheet through exactly one wrapper', async () => {
  const oldWindow = globalThis.window;
  const oldLocation = globalThis.location;
  const oldNavigator = globalThis.navigator;
  const oldWebSocket = globalThis.WebSocket;
  globalThis.window = globalThis;
  globalThis.location = { search: '?encryption=e2e', pathname: '/liveview/s/token/liveview.html' };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { sendBeacon: null } });
  globalThis.WebSocket = FakeWebSocket;
  try {
    const transport = await import(`../liveview-transport.js?test=${Date.now()}`);
    const channel = new FakeControlChannel();
    transport.configureEncryptedControl(async () => channel);
    const signal = transport.openViewerSocket('wss://gateway.example/kbd');
    const frames = [];
    signal.onmessage = (event) => frames.push(JSON.parse(event.data));
    await new Promise((resolve) => setTimeout(resolve, 0));

    channel.receive('dialog', { open: true, seq: 7, type: 'alert', message: 'hi' });
    channel.receive('popup', { open: true, seq: 2 });
    assert.deepEqual(frames, [
      { dialog: { open: true, seq: 7, type: 'alert', message: 'hi' } },
      { popup: { open: true, seq: 2 } },
    ]);

    // The HTTP-fallback shim answers in the same shape the pod's /kbdstate does,
    // so signal.js's bridge unwraps once there too.
    const state = await (await transport.viewerFetch('/kbdstate')).json();
    assert.deepEqual(state.dialog, { open: true, seq: 7, type: 'alert', message: 'hi' });
    assert.deepEqual(state.popup, { open: true, seq: 2 });
  } finally {
    globalThis.window = oldWindow;
    globalThis.location = oldLocation;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: oldNavigator });
    globalThis.WebSocket = oldWebSocket;
  }
});
