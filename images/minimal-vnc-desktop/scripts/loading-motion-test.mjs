import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../extensions/proxy/loading-motion.js', import.meta.url), 'utf8');
function animation(options = {}) {
  const { name = 'arbitrary-decoration', iterations = Infinity, state = 'running',
    pseudo = '::after', frames = [{ transform: 'translateX(-33%)' }, { transform: 'translateX(33%)' }],
    background = 'linear-gradient(90deg, transparent, white, transparent)' } = options;
  return { animationName: name, playState: state, pauses: 0,
    effect: { pseudoElement: pseudo, target: { background },
      getTiming: () => ({ iterations }), getKeyframes: () => frames },
    pause() { this.pauses++; this.playState = 'paused'; } };
}
function install(animations) {
  const listeners = new Map();
  let poll;
  runInNewContext(source, {
    document: { getAnimations: () => animations,
      addEventListener: (name, callback) => listeners.set(name, callback) },
    getComputedStyle: target => ({ backgroundImage: target.background }),
    setInterval: (callback, ms) => { assert.equal(ms, 500); poll = callback; },
  });
  return { fire: name => listeners.get(name)(), poll: () => poll() };
}
test('matches translated gradient decorations independently of animation names', () => {
  const decorations = [animation({ name: 'unrelated-name' }), animation({ name: 'another-name',
    pseudo: '::before', frames: [{ backgroundPositionX: '0%', offset: 0, easing: 'linear' },
      { backgroundPositionX: '100%', computedOffset: 1, composite: 'auto' }] }),
    animation({ frames: [{ transform: 'matrix(1, 0, 0, 1, 10, 0)' }] })];
  install(decorations).poll();
  assert.ok(decorations.every(a => a.pauses === 1));
});
test('preserves finite motion, spinners, opacity, ordinary elements, and non-gradients', () => {
  const others = [animation({ iterations: 1 }), animation({ state: 'finished' }),
    animation({ frames: [{ transform: 'rotate(360deg)' }] }),
    animation({ frames: [{ transform: 'scale(2)' }] }),
    animation({ frames: [{ transform: 'matrix(2, 0, 0, 2, 0, 0)' }] }),
    animation({ frames: [{ opacity: '0' }] }), animation({ pseudo: null }),
    animation({ background: 'url(image.png)' }), animation({ frames: [] }),
    animation({ frames: [{ transform: 'translateX(1px)', opacity: '0.5' }] })];
  const jsAnimation = animation(); delete jsAnimation.animationName; others.push(jsAnimation);
  install(others);
  assert.ok(others.every(a => a.pauses === 0));
});
test('handles dynamically inserted decorations and page-driven restarts', () => {
  const animations = []; const hooks = install(animations);
  const decoration = animation(); animations.push(decoration);
  hooks.fire('animationstart'); assert.equal(decoration.playState, 'paused');
  decoration.playState = 'running'; hooks.poll(); assert.equal(decoration.pauses, 2);
});
test('scans on readiness and visibility changes', () => {
  const animations = []; const hooks = install(animations);
  const decoration = animation(); animations.push(decoration);
  hooks.fire('DOMContentLoaded'); decoration.playState = 'running';
  hooks.fire('visibilitychange'); assert.equal(decoration.pauses, 2);
});
test('cancelled animations do not prevent other decorations from being paused', () => {
  const cancelled = animation(); cancelled.effect.getKeyframes = () => { throw Error('cancelled'); };
  const decoration = animation(); install([cancelled, decoration]);
  assert.equal(decoration.playState, 'paused');
});
test('does not install timers when the animation API is unavailable', () => {
  runInNewContext(source, { document: {}, setInterval: () => assert.fail('unexpected timer') });
});
test('ships in the isolated world at document_start in every extension frame', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extensions/proxy/manifest.json', import.meta.url)));
  const entry = manifest.content_scripts.find(s => s.js.includes('loading-motion.js'));
  assert.equal(entry.run_at, 'document_start'); assert.equal(entry.all_frames, true);
  assert.notEqual(entry.world, 'MAIN');
});
