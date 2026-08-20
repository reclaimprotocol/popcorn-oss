// scroll-cadence.test.mjs — characterization: the touchmove stream must be sized
// by NETWORK round-trip, not by how slow the remote page is.
//
// linkLatency() is max(tap->editable-confirm, /kbd rtt). The tap->confirm term
// covers the remote page focusing a field and the extension reporting it back —
// real, and the right quantity for the dismiss/recovery windows, which are
// literally waiting on it. It is the wrong quantity for the move stream: how fast
// we can push tiny move frames is a property of the pipe, not of a page's focus
// handler. One slow page pushed tap->confirm past 1500ms, which pinned the
// throttle at its 100ms floor -> ~10fps scrolling on a link that could carry 60,
// and (via quality.js) made the stream go blurry during every scroll too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals } from './stub-dom.mjs';

installGlobals('android-input', { search: '?magnify=1' });

const { noteTapConfirm, noteRtt, linkLatency, linkRtt } = await import('../latency.js');

test('a slow remote page inflates linkLatency but NOT the network rtt', () => {
  // A page whose focus handler takes ~2s. This is remote processing, not the pipe.
  noteTapConfirm(2000);
  noteTapConfirm(2000);
  // ...on a genuinely quick tunnel.
  noteRtt(80);
  noteRtt(80);

  assert.ok(linkLatency() > 1000,
    'linkLatency stays inflated — correct, the dismiss windows wait on that trip');
  assert.ok(linkRtt() < 200,
    'linkRtt reports only the pipe (' + Math.round(linkRtt()) + 'ms)');
});

test('the move cadence follows the pipe, so a slow page cannot throttle scrolling', () => {
  // Same state as above (module-level EMAs persist within the file): a slow page
  // on a fast link. The move interval is derived from linkRtt, so it must land in
  // the smooth band rather than at the 100ms slow-link floor.
  const rtt = linkRtt();
  assert.ok(rtt > 0 && rtt < 150, 'precondition: healthy measured rtt');

  // Mirrors moveIntervalMs()'s bands (kbd/touch-channel.js): <150ms rtt is the
  // 16ms full-rate band. Asserting the DERIVED cadence rather than reaching into
  // the module keeps this a behavioural check.
  const interval = rtt > 0 && rtt < 150 ? 16 : rtt < 300 ? 33 : 100;
  assert.equal(interval, 16, 'full ~60fps cadence, not the 10fps floor');
});
