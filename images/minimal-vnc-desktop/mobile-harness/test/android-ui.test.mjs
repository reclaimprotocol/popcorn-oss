// android-ui.test.mjs — checked against hierarchies captured from a real emulator, so
// the assertions are what the platform actually reports rather than what I assumed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isTappable, matchNodes, nodeCenter, parseHierarchy, resolveTapTarget, scrollGestureFor,
} from '../src/android-ui.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dump = (name) => readFileSync(path.join(here, 'fixtures', `${name}.xml`), 'utf8');

test('a real date-picker dump yields the calendar day and the confirm button', () => {
  const xml = dump('ui-date');
  const day = resolveTapTarget(xml, { text: '29' });
  assert.equal(day.found, true);
  assert.ok(day.point.x > 0 && day.point.y > 0);
  // Android labels grid days with an accessible description too; both must resolve.
  assert.equal(resolveTapTarget(xml, { description: '29 August 2026' }).found, true);
  // android:id/button1 is the confirm button in every platform dialog.
  const confirm = resolveTapTarget(xml, { resourceId: 'android:id/button1' });
  assert.equal(confirm.found, true);
  assert.equal(confirm.node.text, 'SET');
});

test('a select dialog resolves an option by its label', () => {
  const target = resolveTapTarget(dump('ui-native-select-picker'), { text: 'Business' });
  assert.equal(target.found, true);
  assert.equal(target.node.resourceId, 'android:id/text1');
});

test('a NumberPicker resolves its visible neighbours, which is how it is stepped', () => {
  const xml = dump('ui-native-month-picker');
  for (const month of ['Jul', 'Aug', 'Sep']) {
    assert.equal(resolveTapTarget(xml, { text: month }).found, true, `${month} must be tappable`);
  }
  // Tapping the neighbour is what advances the wheel, so the points must differ.
  const august = resolveTapTarget(xml, { text: 'Aug' }).point;
  const september = resolveTapTarget(xml, { text: 'Sep' }).point;
  assert.notDeepEqual(august, september);
  assert.ok(september.y > august.y, 'Sep sits below Aug in the wheel');
});

test('the time picker exposes its radial hours by description', () => {
  const xml = dump('ui-native-time-picker');
  const hour = resolveTapTarget(xml, { description: '11' });
  assert.equal(hour.found, true);
  // The five-minute radial cannot express 16, which is why that case types instead.
  assert.equal(resolveTapTarget(xml, { description: '16' }).found, false);
  assert.equal(resolveTapTarget(xml, { resourceId: 'android:id/toggle_mode' }).found, true);
});

test('a node with no area is never tapped', () => {
  // An off-screen row is still in the hierarchy; tapping its "centre" would hit
  // whatever is painted there instead, and the case would fail somewhere else.
  assert.equal(isTappable({ bounds: { left: 0, top: 0, right: 0, bottom: 0 } }), false);
  assert.equal(isTappable({ bounds: { left: 0, top: -120, right: 400, bottom: -20 } }), false);
  assert.equal(isTappable({ bounds: null }), false);
  assert.equal(isTappable({ bounds: { left: 10, top: 10, right: 20, bottom: 20 } }), true);

  const xml = '<hierarchy>'
    + '<node text="A" bounds="[0,-100][100,-50]" />'
    + '<node text="A" bounds="[0,200][100,260]" />'
    + '</hierarchy>';
  const target = resolveTapTarget(xml, { text: 'A' });
  assert.equal(target.matches, 2);
  assert.equal(target.tappable, 1);
  assert.deepEqual(target.point, { x: 50, y: 230 });
});

test('a missing element is reported, not silently tapped somewhere', () => {
  const target = resolveTapTarget(dump('ui-native-select-picker'), { text: 'Zimbabwe' });
  assert.equal(target.found, false);
  assert.equal(target.point, null);
});

test('selectors are validated instead of matching everything', () => {
  assert.throws(() => matchNodes([], {}), /needs text, textContains/);
  assert.throws(() => matchNodes([], null), /must be an object/);
  assert.throws(() => resolveTapTarget('<hierarchy/>', { text: 'A', instance: -1 }), /whole number/);
});

test('textContains matches a label whose exact wording belongs to the site', () => {
  const xml = '<hierarchy><node text="Vertical Scrolling Test" bounds="[0,10][300,70]" /></hierarchy>';
  assert.equal(resolveTapTarget(xml, { textContains: 'Vertical Scrolling' }).found, true);
});

test('a scroll gesture stays inside the scrollable list', () => {
  const xml = '<hierarchy>'
    + '<node class="android.widget.FrameLayout" scrollable="false" bounds="[0,0][1080,2400]" />'
    + '<node class="android.widget.ListView" scrollable="true" bounds="[100,500][980,1700]" />'
    + '</hierarchy>';
  const down = scrollGestureFor(xml, { direction: 'down' });
  assert.equal(down.fromX, 540);
  assert.ok(down.fromY > down.toY, 'scrolling down drags upward');
  for (const y of [down.fromY, down.toY]) {
    assert.ok(y > 500 && y < 1700, `${y} must stay inside the list, or another view scrolls`);
  }
  const up = scrollGestureFor(xml, { direction: 'up' });
  assert.ok(up.fromY < up.toY);
  assert.equal(scrollGestureFor('<hierarchy/>'), null);
});

test('the parser reads the attributes the pickers are addressed by', () => {
  const nodes = parseHierarchy(dump('ui-date'));
  assert.ok(nodes.length > 40, `expected a full hierarchy, got ${nodes.length} nodes`);
  const picker = nodes.find((n) => n.resourceId === 'android:id/datePicker');
  assert.ok(picker, 'the dialog root must be present');
  assert.equal(typeof picker.scrollable, 'boolean');
  assert.deepEqual(nodeCenter({ bounds: { left: 10, top: 20, right: 30, bottom: 60 } }), { x: 20, y: 40 });
});
