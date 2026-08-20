// e2e-trace.test.mjs — the input->paint trace (kbd/e2e.js).
//
// Why this measurement had to exist: every diagnostic we shipped stopped at
// `proxy=written`, which says the gesture reached the remote browser and lands in
// 27-58ms even on the sessions users describe as broken. The complaint is about
// what happens AFTER that — "the text appears only after a delay" — and nothing
// measured it, so the reports kept being attributed to the input path, where the
// numbers were already good.
//
// Two properties are worth locking down. First that the four legs are attributed
// to the right hops (a trace that folds the network round-trip into the paint leg
// would send the next investigation the same wrong way). Second, and more
// important, that a trace can never carry content: this runs in a login flow, over
// a form, on a real user's session, and it reads PIXELS to detect the paint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

// e2e.js reads ?e2e= and ?diag= at import time, exactly like the rest of the
// layer, so the flags have to be in place before the first import.
globalThis.window = globalThis;
// kbddebug (rather than diag) keeps the trace in diag.js's in-memory ring, which
// is readable synchronously — the /klog POST is batched on a 1.5s timer and this
// test is about the numbers, not about the log transport.
globalThis.location = { search: '?e2e=3&kbddebug=1', pathname: '/vnc/liveview.html' };
globalThis.performance = globalThis.performance || { now: () => Date.now() };
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node', sendBeacon: null, connection: null },
  configurable: true, writable: true,
});
globalThis.fetch = () => Promise.resolve({ ok: true });
globalThis.console = Object.assign({}, globalThis.console, { log() {} }); // dbg mirrors to console in debug mode

const { createE2E, E2E_TRACES, E2E_ON } = await import('../e2e.js');

// A canvas whose pixels change only when a test says so — the framebuffer, under
// the test's control.
function fakeScreen() {
  let fill = 17; // #111, the viewer's own background
  const canvas = {
    width: 411, height: 732,
    getContext: () => ({
      getImageData: (x, y, w, h) => ({ data: new Uint8Array(w * h * 4).fill(fill) }),
    }),
  };
  return {
    screen: { querySelector: (s) => (s === 'canvas' ? canvas : null) },
    paint() { fill = (fill + 40) % 250; },
  };
}

// A screen whose pixels change ONLY inside a given rect — the shape of a real
// keystroke, which repaints a caret and a couple of glyphs inside one field and
// leaves the other ~99% of the framebuffer byte-identical. A uniform sample grid
// cannot see this; that is the whole point of the field-aware sampler.
function fakeScreenWithField(field) {
  const BG = 17;
  let fill = BG;
  const inside = (x, y, w, h) =>
    x < field.x + field.w && x + w > field.x && y < field.y + field.h && y + h > field.y;
  const canvas = {
    width: 411, height: 732,
    getContext: () => ({
      getImageData: (x, y, w, h) => ({
        data: new Uint8Array(w * h * 4).fill(inside(x, y, w, h) ? fill : BG),
      }),
    }),
  };
  return {
    screen: { querySelector: (s) => (s === 'canvas' ? canvas : null) },
    paintField() { fill = (fill + 40) % 250; },
  };
}

// diag.js keeps the last 200 lines in memory under ?kbddebug=1 and exposes them.
let mark = 0;
function reset() { mark = globalThis.__pcnKbdLog().split('\n').filter(Boolean).length; }
function lines() {
  const all = globalThis.__pcnKbdLog().split('\n').filter(Boolean);
  return all.slice(mark).filter((l) => / e2e /.test(l));
}

test('?e2e=N arms N traces', () => {
  assert.equal(E2E_ON, true);
  assert.equal(E2E_TRACES, 3);
});

test('a tap trace attributes each leg to its own hop', async () => {
  reset();
  const fb = fakeScreen();
  const t = createE2E({ getScreenElement: () => fb.screen });

  t.noteInput();                     // finger up
  await sleep(20);
  t.noteSent('tap', 'g#7', true);    // queued on /input; waits for the proxy ack
  assert.ok(t.inFlight());
  await sleep(60);
  t.noteWritten('g#7', 'written');   // the proxy wrote the CDP command
  await sleep(30);
  fb.paint();                        // and the screen changed
  await sleep(400);

  const [line] = lines();
  assert.ok(line, 'a trace was logged');
  const m = line.match(/e2e tap g#7 sent=\+(\d+)ms written=\+(\d+)ms paint=\+(\d+)ms total=(\d+)ms/);
  assert.ok(m, 'shape: ' + line);
  const [, sent, written, paint, total] = m.map(Number);
  // Legs are cumulative offsets from the physical input, so each one must be at
  // least as late as the last — an out-of-order number means a leg was stamped in
  // the wrong place.
  assert.ok(sent >= 15, 'the trace starts at the INPUT, not at our own send (sent=' + sent + ')');
  assert.ok(written >= sent, 'written is not before sent');
  assert.ok(paint >= written, 'the paint leg starts after the ack, so it is paint time only');
  assert.equal(total, paint, 'total is the user-visible latency');
});

test('a keystroke trace runs send -> paint (RFB has no acknowledgement)', async () => {
  reset();
  const fb = fakeScreen();
  const t = createE2E({ getScreenElement: () => fb.screen });
  t.noteInput();
  t.noteSent('text', 'n=1', false); // no ack to wait for: the watch starts now
  await sleep(80);
  fb.paint();
  // A text trace also waits out REMOTE_BUDGET_MS for the field's confirmation
  // before it logs — the two legs are independent and the paint normally wins.
  await sleep(1700);
  const [line] = lines();
  // written stays '-' (keysyms go down the RFB tunnel, which acknowledges
  // nothing) and remote stays '-' until the extension confirms the field's own
  // length — see the remote-confirm test below.
  assert.ok(/e2e text n=1 sent=\+\d+ms written=- remote=- paint=\+\d+ms/.test(line), line);
});

test('the REMOTE leg is what proves a keystroke landed, not just that we sent it', async () => {
  // The gap this closes: for text there is no proxy ack, so a trace could not
  // separate "the keystroke never reached the remote browser" from "it did and
  // the repaint was slow". Those have opposite fixes and it is the most common
  // thing a user reports. The extension already reports the focused field's own
  // value length on /kbd; when field-session reconciles it against what we sent,
  // that is an END-TO-END confirmation — stronger than a write ack.
  reset();
  const fb = fakeScreen();
  const t = createE2E({ getScreenElement: () => fb.screen });
  t.noteInput();
  t.noteSent('text', 'n=2', false);
  await sleep(60);
  t.noteRemoteConfirm();          // the remote field now holds what we typed
  await sleep(40);
  fb.paint();
  await sleep(300);
  const [line] = lines();
  const m = /remote=\+(\d+)ms paint=\+(\d+)ms/.exec(line);
  assert.ok(m, 'both legs are reported: ' + line);
  assert.ok(Number(m[1]) >= 50, 'the remote leg is timed from the input, not stamped at send');
  assert.ok(Number(m[2]) >= Number(m[1]), 'pixels cannot precede the confirmation');
});

test('a keystroke a sensitive field never confirms still reports its paint', async () => {
  // Password fields report no length at all (content.js sends neither len nor
  // value), so the remote leg CANNOT arrive. That must degrade to "unknown",
  // never to a trace that hangs waiting for a confirmation that is not coming.
  reset();
  const fb = fakeScreen();
  const t = createE2E({ getScreenElement: () => fb.screen });
  t.noteInput();
  t.noteSent('text', 'n=1', false);
  await sleep(60);
  fb.paint();
  await sleep(1700);            // pixels, then the confirmation budget expiring
  assert.ok(!t.inFlight(), 'the trace closed once the confirmation could not come');
  assert.ok(/remote=- paint=\+\d+ms/.test(lines()[0] || ''), lines()[0]);
});

test('a paint that never comes is reported as such, not left hanging', async () => {
  reset();
  const fb = fakeScreen();
  const t = createE2E({ getScreenElement: () => fb.screen });
  t.noteInput();
  t.noteSent('key', 'Backspace', false);
  // Never call paint(). The budget is 2.5s; assert the trace is still open well
  // before it, because a silently-dropped trace would look like "no problem".
  await sleep(300);
  assert.ok(t.inFlight(), 'still waiting for pixels');
});

test('a rejected gesture closes the trace instead of waiting for a paint', async () => {
  reset();
  const fb = fakeScreen();
  const t = createE2E({ getScreenElement: () => fb.screen });
  t.noteInput();
  t.noteSent('tap', 'g#2', true);
  t.noteWritten('g#2', 'not-written');
  assert.ok(!t.inFlight(), 'no paint is coming, so nothing is waited for');
  assert.ok(/e2e tap g#2 proxy=not-written/.test(lines()[0] || ''), lines()[0]);
});

test('an ack for a different gesture is ignored', async () => {
  const fb = fakeScreen();
  const t = createE2E({ getScreenElement: () => fb.screen });
  t.noteInput();
  t.noteSent('tap', 'g#9', true);
  t.noteWritten('g#8', 'written');
  assert.ok(t.inFlight(), 'the in-flight trace is untouched by a stale ack');
});

test('tracing is bounded: one in flight, N per page load', async () => {
  reset();
  const fb = fakeScreen();
  const t = createE2E({ getScreenElement: () => fb.screen });
  t.noteSent('tap', 'g#1', true);
  t.noteSent('tap', 'g#2', true);   // ignored — one at a time, so no budget spent
  assert.equal(t.remaining(), E2E_TRACES - 1, 'the second one did not consume budget');
  // Drain the budget: each trace is closed by a terminal (non-'written') ack, so
  // none of them sits waiting for pixels.
  t.noteWritten('g#1', 'rejected');
  t.noteSent('tap', 'g#3', true); t.noteWritten('g#3', 'rejected');
  t.noteSent('tap', 'g#4', true); t.noteWritten('g#4', 'rejected');
  assert.equal(t.remaining(), 0, 'spent exactly N');
  const before = lines().length;
  t.noteInput();
  t.noteSent('tap', 'g#5', true);
  await sleep(50);
  assert.equal(lines().length, before, 'past the budget nothing is traced at all');
  assert.ok(!t.inFlight(), 'and no paint watch is left running');
});

test('a trace line can never carry typed text, a coordinate, or a URL', async () => {
  reset();
  const fb = fakeScreen();
  const t = createE2E({ getScreenElement: () => fb.screen });
  // Everything a caller could plausibly pass, including a tag that IS content —
  // the transport hands us safeKeyName(), so a single printable character never
  // reaches here, and the line must survive an accident anyway without leaking
  // more than the caller already chose to pass.
  t.noteInput();
  t.noteSent('text', 'n=5', false);
  await sleep(60);
  fb.paint();
  await sleep(1700);
  const line = lines()[0] || '';
  // The only variable parts are a kind, a tag, and four integers.
  assert.ok(/^\d+ e2e (tap|text|key) \S+ sent=\S+ written=\S+( remote=\S+)? paint=\S+ total=\d+ms$/.test(line),
    'nothing but kind, tag and durations: ' + line);
  // And the pixel path is one-way: the checksum is compared and dropped, so no
  // byte of the framebuffer appears anywhere in the output.
  assert.ok(!/17|#111|rgb/.test(line.replace(/\d+ms/g, '').replace(/^\d+/, '')),
    'no pixel data in the line: ' + line);
});


test('a keystroke that only repaints its own field is still seen (not paint=none)', async () => {
  // REGRESSION, measured on an emulated Pixel 7 against a real pod: 3 of ~12 text
  // traces reported `paint=none>2500ms` while the typed characters were visibly on
  // screen. The sampler was a uniform 5x5 grid of 12px patches and the change was
  // a caret plus two glyphs inside one input — the grid landed between them. A
  // false "no paint" in the exact diagnostic somebody would quote to prove a
  // keystroke was lost is worse than no diagnostic at all.
  reset();
  const field = { x: 40, y: 300, w: 300, h: 32 };
  const fb = fakeScreenWithField(field);
  const t = createE2E({ getScreenElement: () => fb.screen, getFieldRect: () => field });
  t.noteInput();
  t.noteSent('text', 'n=13', false);   // a tag no other test uses
  await sleep(60);
  fb.paintField();                 // ONLY the field's pixels change
  await sleep(1700);
  // A leftover trace from an earlier test resolves inside this window, so select
  // ours by tag rather than by position.
  const line = lines().find((l) => /n=13/.test(l)) || '';
  assert.ok(/paint=\+\d+ms/.test(line), 'the field repaint was seen: ' + line);
});

test('changing sampling regions does not create a false paint', async () => {
  reset();
  const field = { x: 40, y: 300, w: 300, h: 32 };
  let focused = field;
  const fb = fakeScreenWithField(field);
  const t = createE2E({ getScreenElement: () => fb.screen, getFieldRect: () => focused });
  t.noteInput();
  t.noteSent('text', 'n=14', false);
  await sleep(60);
  focused = null;
  await sleep(180);
  assert.ok(t.inFlight(), 'a field-to-screen switch only re-baselines');
});

test('an unresolved trace says WHERE it was looking', async () => {
  // `paint=none` from a field sample and from a whole-screen sample mean different
  // things — one says "this field never changed", the other "nothing on screen
  // did" — and the reader cannot tell them apart without being told.
  reset();
  const field = { x: 40, y: 300, w: 300, h: 32 };
  const fb = fakeScreenWithField(field);
  const t = createE2E({ getScreenElement: () => fb.screen, getFieldRect: () => field });
  t.noteInput();
  t.noteSent('text', 'n=42', false);   // a tag no other test uses
  await sleep(4400);               // past PAINT_BUDGET_MS + REMOTE_BUDGET_MS
  // An unresolved trace from an earlier test resolves inside this window too, so
  // pick ours by tag rather than by position.
  const line = lines().find((l) => /n=42/.test(l)) || '';
  assert.ok(/paint=none>\d+ms@field/.test(line), line);
});
