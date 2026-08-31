#!/usr/bin/env python3
"""matrix.py — drive each installed Android IME against the live LiveView viewer.

Types with the REAL on-screen keyboard (never `adb shell input text`, which
injects key events straight at the input dispatcher and bypasses the IME
entirely — see mobile-harness/src/text-entry.mjs), then reads the remote field
back through CDP at code-point level.

Keys are located by their accessibility label via `uiautomator dump`, not by
hardcoded coordinates: every keyboard lays its keys out differently, and a
coordinate table only ever matches the one keyboard it was calibrated against.

Chain under test:
    on-screen IME -> viewer proxy -> value-diff -> RFB -> remote browser field
"""
import json, re, subprocess, sys, time, urllib.request, websocket

SERIAL = "emulator-5554"
CDP_RUNTIME = 19226           # full CDP into the remote browser
FIXTURE_FIELDS = ("username", "email", "password", "otp", "plainpass")

def adb(*args, timeout=60):
    return subprocess.run(["adb", "-s", SERIAL, *args],
                          capture_output=True, text=True, timeout=timeout).stdout

# ---- remote page (through CDP) --------------------------------------------
_rpc_id = [0]
def _rpc(ws, method, params=None, sid=None):
    _rpc_id[0] += 1
    m = {"id": _rpc_id[0], "method": method, "params": params or {}}
    if sid: m["sessionId"] = sid
    ws.send(json.dumps(m))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == _rpc_id[0]: return r

class Remote:
    def __init__(self):
        v = json.load(urllib.request.urlopen(f"http://localhost:{CDP_RUNTIME}/json/version", timeout=10))
        self.ws = websocket.create_connection(v["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
        page = [t for t in _rpc(self.ws, "Target.getTargets")["result"]["targetInfos"]
                if t["type"] == "page"][0]
        self.sid = _rpc(self.ws, "Target.attachToTarget",
                        {"targetId": page["targetId"], "flatten": True})["result"]["sessionId"]
    def ev(self, expr):
        r = _rpc(self.ws, "Runtime.evaluate",
                 {"expression": expr, "returnByValue": True, "awaitPromise": True}, self.sid)
        return r.get("result", {}).get("result", {}).get("value")
    def focus(self, field):
        return self.ev(f"(()=>{{var e=document.getElementById('{field}');e.focus();return e.type;}})()")
    def clear(self):
        self.ev("[%s].forEach(i=>{var e=document.getElementById(i);if(e)e.value='';})"
                % ",".join(f"'{f}'" for f in FIXTURE_FIELDS))
    def codepoints(self, field):
        raw = self.ev("JSON.stringify(window.__wsDiag())")
        return json.loads(raw)[field]["codePoints"] if raw else None

# ---- on-screen keyboard ----------------------------------------------------
BOUNDS = re.compile(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')

def ui_dump():
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    return adb("shell", "cat", "/sdcard/ui.xml")

def find_key(dump, label):
    """Centre of the key whose content-desc or text equals `label`, case-insensitive.
    Exact match only: a substring match picks 'Delete word' when asked for 'Delete'."""
    for node in dump.split(">"):
        for attr in ("content-desc", "text"):
            m = re.search(attr + r'="([^"]*)"', node)
            if m and m.group(1).strip().lower() == label.lower():
                b = BOUNDS.search(node)
                if b:
                    x1, y1, x2, y2 = map(int, b.groups())
                    return (x1 + x2) // 2, (y1 + y2) // 2
    return None

class Keyboard:
    def __init__(self):
        self.dump = ui_dump()
    def tap(self, label, settle=0.45):
        pt = find_key(self.dump, label)
        if not pt:
            self.dump = ui_dump()           # layout may have shifted (shift/symbols)
            pt = find_key(self.dump, label)
        if not pt:
            return False
        adb("shell", "input", "tap", str(pt[0]), str(pt[1]))
        time.sleep(settle)
        return True
    def type(self, text):
        return all(self.tap(ch) for ch in text)

# ---- IME control -----------------------------------------------------------
def ime_list():
    return [l.strip() for l in adb("shell", "ime", "list", "-s", "-a").splitlines() if l.strip()]

def ime_select(ime_id):
    adb("shell", "ime", "enable", ime_id)
    adb("shell", "ime", "set", ime_id)
    time.sleep(2.5)
    return adb("shell", "settings", "get", "secure", "default_input_method").strip()

def keyboard_up():
    return "mInputShown=true" in adb("shell", "dumpsys", "input_method")

def raise_keyboard(tap_xy):
    for _ in range(3):
        if keyboard_up(): return True
        adb("shell", "input", "tap", str(tap_xy[0]), str(tap_xy[1]))
        time.sleep(3)
    return keyboard_up()
