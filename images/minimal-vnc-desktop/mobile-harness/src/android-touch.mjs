// android-touch.mjs — native touch payloads for the ADB transport.
//
// Android's `uinput` command speaks NUMBERS, not the linux/input-event-codes.h
// names, and it rejects a bad payload by exiting non-zero with NOTHING on either
// stream — the reason reaches logcat only. Sending names cost every Android pinch
// with "unknown uinput error":
//   No enum constant com.android.commands.uinput.Event.Bus.VIRTUAL
//   java.lang.IllegalStateException: Expected END_ARRAY but was END_OBJECT
// Named constants here, numbers on the wire, and a test that keeps it that way.

export function pointerGestures(pointer) {
  let x;
  let y;
  let down = false;
  let fromX;
  let fromY;
  let durationMs = 0;
  let delayBeforeMs = 0;
  // A pause between pointerDown and the FIRST move is a press-and-hold, and it is
  // the whole gesture for a long-press drag (a reorder list, a drag to a target
  // that only appears once dragging starts). Folding it into durationMs the way
  // every other pause is folded left `input swipe` doing a slightly slower swipe
  // with no hold at all, so the page never entered drag mode: both such cases
  // completed their gesture and then timed out waiting for the drop marker.
  let holdMs = 0;
  let movedWhileDown = false;
  const gestures = [];
  for (const action of pointer.actions ?? []) {
    if (action.type === 'pointerMove') {
      x = Number(action.x);
      y = Number(action.y);
      if (down) { movedWhileDown = true; durationMs += Math.max(0, Number(action.duration ?? 0)); }
    } else if (action.type === 'pointerDown') {
      down = true;
      fromX = x;
      fromY = y;
      durationMs = 0;
      holdMs = 0;
      movedWhileDown = false;
    } else if (action.type === 'pause') {
      if (down && !movedWhileDown) holdMs += Math.max(0, Number(action.duration ?? 0));
      else if (down) durationMs += Math.max(0, Number(action.duration ?? 0));
      else delayBeforeMs += Math.max(0, Number(action.duration ?? 0));
    } else if (action.type === 'pointerUp' && down) {
      gestures.push({ fromX, fromY, toX: x, toY: y, durationMs, delayBeforeMs, holdMs });
      down = false;
      delayBeforeMs = 0;
      holdMs = 0;
    }
  }
  return gestures;
}

function uinputCommand(id, command, values = {}) {
  return `${JSON.stringify({ id, command, ...values })}\n`;
}

const UI_SET = { EVBIT: 100, KEYBIT: 101, ABSBIT: 103, PROPBIT: 110 };
const EV = { SYN: 0, KEY: 1, ABS: 3 };
const SYN_REPORT = 0;
const BTN_TOUCH = 330;
const ABS_MT = {
  SLOT: 47, TOUCH_MAJOR: 48, POSITION_X: 53, POSITION_Y: 54,
  TOOL_TYPE: 55, TRACKING_ID: 57, PRESSURE: 58,
};
const INPUT_PROP_DIRECT = 1;

export function androidMultiTouchPayload(gestures, width, height) {
  const id = 1;
  const slotMaximum = Math.max(1, gestures.length - 1);
  const axis = (code, maximum) => ({
    code,
    info: { value: 0, minimum: 0, maximum, fuzz: 0, flat: 0, resolution: 1 },
  });
  let payload = uinputCommand(id, 'register', {
    name: 'Popcorn Native Multi-Touch',
    vid: 0x18d1,
    pid: 0x4ee7,
    // 'virtual' is not one of the tool's Bus values; usb and bluetooth are.
    bus: 'usb',
    configuration: [
      { type: UI_SET.EVBIT, data: [EV.KEY, EV.ABS] },
      { type: UI_SET.KEYBIT, data: [BTN_TOUCH] },
      { type: UI_SET.ABSBIT, data: [
        ABS_MT.SLOT, ABS_MT.POSITION_X, ABS_MT.POSITION_Y,
        ABS_MT.TRACKING_ID, ABS_MT.TOOL_TYPE, ABS_MT.TOUCH_MAJOR, ABS_MT.PRESSURE,
      ] },
      { type: UI_SET.PROPBIT, data: [INPUT_PROP_DIRECT] },
    ],
    abs_info: [
      axis(ABS_MT.SLOT, slotMaximum),
      axis(ABS_MT.POSITION_X, width - 1),
      axis(ABS_MT.POSITION_Y, height - 1),
      axis(ABS_MT.TRACKING_ID, 65535),
      axis(ABS_MT.TOOL_TYPE, 15),
      axis(ABS_MT.TOUCH_MAJOR, Math.max(width, height) - 1),
      axis(ABS_MT.PRESSURE, 255),
    ],
  });
  payload += uinputCommand(id, 'delay', { duration: 600 });

  const event = (type, code, value) => [type, code, value];
  const startEvents = [event(EV.KEY, BTN_TOUCH, 1)];
  gestures.forEach((gesture, slot) => {
    startEvents.push(
      event(EV.ABS, ABS_MT.SLOT, slot),
      event(EV.ABS, ABS_MT.TRACKING_ID, 100 + slot),
      event(EV.ABS, ABS_MT.TOOL_TYPE, 0),
      event(EV.ABS, ABS_MT.POSITION_X, Math.round(gesture.fromX)),
      event(EV.ABS, ABS_MT.POSITION_Y, Math.round(gesture.fromY)),
      event(EV.ABS, ABS_MT.TOUCH_MAJOR, 24),
      event(EV.ABS, ABS_MT.PRESSURE, 200),
    );
  });
  startEvents.push(event(EV.SYN, SYN_REPORT, 0));
  payload += uinputCommand(id, 'inject', { events: startEvents.flat() });
  const holdMs = Math.max(0, Math.max(...gestures.map(
    (gesture) => Number(gesture.holdMs ?? 0) || Number(gesture.delayBeforeMs ?? 0),
  )));
  if (holdMs) payload += uinputCommand(id, 'delay', { duration: holdMs });

  const steps = 16;
  const durationMs = Math.max(100, Math.max(...gestures.map((gesture) => Number(gesture.durationMs || 450))));
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const moveEvents = [];
    gestures.forEach((gesture, slot) => {
      moveEvents.push(
        event(EV.ABS, ABS_MT.SLOT, slot),
        event(EV.ABS, ABS_MT.POSITION_X, Math.round(gesture.fromX + (gesture.toX - gesture.fromX) * progress)),
        event(EV.ABS, ABS_MT.POSITION_Y, Math.round(gesture.fromY + (gesture.toY - gesture.fromY) * progress)),
      );
    });
    moveEvents.push(event(EV.SYN, SYN_REPORT, 0));
    payload += uinputCommand(id, 'inject', { events: moveEvents.flat() });
    payload += uinputCommand(id, 'delay', { duration: Math.max(8, Math.round(durationMs / steps)) });
  }

  const endEvents = [];
  gestures.forEach((gesture, slot) => {
    endEvents.push(
      event(EV.ABS, ABS_MT.SLOT, slot),
      event(EV.ABS, ABS_MT.TRACKING_ID, -1),
    );
  });
  endEvents.push(event(EV.KEY, BTN_TOUCH, 0), event(EV.SYN, SYN_REPORT, 0));
  payload += uinputCommand(id, 'inject', { events: endEvents.flat() });
  payload += uinputCommand(id, 'delay', { duration: 100 });
  return payload;
}

