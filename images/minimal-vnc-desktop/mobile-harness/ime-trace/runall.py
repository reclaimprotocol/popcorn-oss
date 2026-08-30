#!/usr/bin/env python3
"""runall.py — run the credential cases against every installed IME.

Key positions are DERIVED from the IME window rectangle (dumpsys input_method
reports touchableRegion) rather than hand-measured per keyboard, then VERIFIED by
probing: tap the candidate 'a' and require the remote field to read [97] before
trusting the rest of the grid. A keyboard whose layout does not match is reported
as CALIBRATION-FAILED, never as a product failure — the difference matters, and
guessing coordinates silently produced three false bug reports earlier.

Every soft keyboard here anchors the same four rows to the bottom of its window
(qwerty / asdf / zxcv / space), whatever it stacks above them, so counting rows
UP from the bottom generalises where counting down does not.
"""
import json, re, subprocess, sys, time, urllib.request, websocket

SERIAL = "emulator-5556"
TAPY = 1000           # framebuffer point that raises the keyboard
ROW_PX = 155.0        # nominal row height at 420dpi; only used to guess row count

def adb(*a, t=60):
    return subprocess.run(["adb", "-s", SERIAL, *a], capture_output=True, text=True, timeout=t).stdout

def ime_region(tries=10):
    """mInputShown can be true before the IME view has laid out, and a keyboard
    opening for the FIRST time is slow — so poll rather than read once. Also
    reject a stub rectangle: a real keyboard is hundreds of pixels tall."""
    for _ in range(tries):
        d = adb("shell", "dumpsys", "input_method")
        m = re.search(r"touchableRegion=SkRegion\(\((\d+),(\d+),(\d+),(\d+)\)", d)
        if m:
            x0, y0, x1, y1 = map(int, m.groups())
            if y1 - y0 > 300:
                return (x0, y0, x1, y1)
        time.sleep(1.5)
    return None

def kb_up():
    return "mInputShown=true" in adb("shell", "dumpsys", "input_method")

def tap(x, y, settle=0.9):
    adb("shell", "input", "tap", str(int(x)), str(int(y))); time.sleep(settle)

def swipe(x1, y1, x2, y2, ms=250, settle=1.2):
    adb("shell", "input", "swipe", *map(lambda v: str(int(v)), (x1, y1, x2, y2)), str(ms))
    time.sleep(settle)

def longpress(x, y, ms=700, settle=1.2):
    swipe(x, y, x, y, ms, settle)

# ---- remote field ----------------------------------------------------------
_i = [0]
def _rpc(ws, m, p=None, sid=None):
    _i[0] += 1
    msg = {"id": _i[0], "method": m, "params": p or {}}
    if sid: msg["sessionId"] = sid
    ws.send(json.dumps(msg))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == _i[0]: return r

class Remote:
    def __init__(self):
        v = json.load(urllib.request.urlopen("http://localhost:19226/json/version", timeout=10))
        self.ws = websocket.create_connection(v["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
        pg = [t for t in _rpc(self.ws, "Target.getTargets")["result"]["targetInfos"] if t["type"] == "page"][0]
        self.sid = _rpc(self.ws, "Target.attachToTarget", {"targetId": pg["targetId"], "flatten": True})["result"]["sessionId"]
    def ev(self, e):
        return _rpc(self.ws, "Runtime.evaluate", {"expression": e, "returnByValue": True}, self.sid)["result"]["result"].get("value")
    def cps(self):
        raw = self.ev("JSON.stringify(window.__wsDiag())")
        return json.loads(raw)["password"]["codePoints"] if raw else []
    # A field change is what makes field-session call clearProxy(); clearing
    # .value alone leaves the viewer's lastSentValue stale and the next diff
    # replays it.
    def reset(self):
        self.ev("['username','password'].forEach(i=>{var e=document.getElementById(i);if(e)e.value='';})")
        self.ev("document.getElementById('username').focus()"); time.sleep(1.5)
        self.ev("document.getElementById('password').focus()"); time.sleep(1.5)
        self.ev("document.getElementById('password').value=''"); time.sleep(0.8)
    def focused(self):
        return self.ev("document.activeElement.id")

def raise_kb(r):
    for _ in range(4):
        if kb_up(): return True
        tap(540, TAPY, 3.0)
    return kb_up()

def grid(region):
    x0, y0, x1, y1 = region
    W, H = x1 - x0, y1 - y0
    rows = max(4, round(H / ROW_PX))
    rh = H / rows
    # counted UP from the bottom of the window
    y_space = y1 - 0.5 * rh
    y_z     = y1 - 1.5 * rh
    y_a     = y1 - 2.5 * rh
    return {
        "a":     (x0 + 0.10 * W, y_a),
        "b":     (x0 + 0.60 * W, y_z),
        "space": (x0 + 0.50 * W, y_space),
        "bksp":  (x0 + 0.93 * W, y_z),
        "rows": rows, "rh": rh,
    }

def calibrate(r, g):
    """Probe 'a'. Try a few x offsets for the asdf row, which some keyboards
    indent by half a key and others do not."""
    x0 = g["a"][0]
    for dx in (0.0, -0.04, 0.04, -0.07, 0.07):
        r.reset()
        if not raise_kb(r): return None
        if r.focused() != "password": return None
        cand = (x0 + dx * 1080, g["a"][1])
        tap(*cand)
        if r.cps() == [97]:
            return cand
    return None

def run(ime, label):
    # `ime set` silently no-ops for a keyboard that is not enabled, leaving the
    # PREVIOUS IME active — so without this the same keyboard gets tested over and
    # over under different names. Enable, set, then confirm it actually took.
    adb("shell", "ime", "enable", ime)
    adb("shell", "ime", "set", ime); time.sleep(3)
    active = adb("shell", "settings", "get", "secure", "default_input_method").strip()
    if ime.split("/")[0] not in active:
        print(f"  {label:<34} IME-SWITCH-FAILED (still {active.split('/')[0]})"); return
    r = Remote()
    r.reset()
    if not raise_kb(r):
        print(f"  {label:<34} KEYBOARD-DID-NOT-OPEN"); return
    reg = ime_region()
    if not reg:
        print(f"  {label:<34} NO-IME-REGION"); return
    g = grid(reg)
    a = calibrate(r, g)
    if not a:
        print(f"  {label:<34} CALIBRATION-FAILED (region={reg} rows={g['rows']})"); return
    res = []
    def step(xy, expect, name):
        if not kb_up():
            res.append(f"{name}:KBD-DOWN"); return
        tap(*xy)
        got = r.cps()
        res.append(f"{name}:{'ok' if got == expect else 'FAIL'+str(got)}")
    step(g["b"], [97, 98], "ab")
    step(g["space"], [97, 98, 32], "space")
    step(g["space"], [97, 98, 32, 32], "dblspace")
    step(g["bksp"], [97, 98, 32], "bksp")

    # ---- beyond the credential cases: how people actually type ---------------
    # Each of these is reported as an OBSERVATION, not pass/fail: the correct
    # result depends on the keyboard (a non-glide keyboard rightly produces
    # nothing for a swipe), so a fixed expectation would manufacture failures.
    def observe(name, fn):
        if not kb_up():
            res.append(f"{name}:KBD-DOWN"); return
        before = r.cps()
        fn()
        after = r.cps()
        # Report the real transition. A naive tail-diff mis-reads every DELETION
        # as "no change", which silently turns a broken held-backspace into a
        # clean-looking result.
        if after == before:
            what = "nochange"
        elif len(after) < len(before) and before[:len(after)] == after:
            what = f"-{len(before) - len(after)}"
        elif len(after) > len(before) and after[:len(before)] == before:
            what = "+" + repr("".join(map(chr, after[len(before):])))
        else:
            what = f"{''.join(map(chr, before))!r}->{''.join(map(chr, after))!r}"
        res.append(f"{name}:{what}" + ("" if kb_up() else "/KBD-DOWN"))

    # Glide: drag across g-h-j on the asdf row. A glide keyboard commits a word;
    # a non-glide one emits nothing or a single letter.
    x0, _, x1, _ = reg
    W = x1 - x0
    observe("glide", lambda: swipe(x0 + 0.45 * W, g["a"][1], x0 + 0.65 * W, g["a"][1], 420))
    # Held backspace: should repeat-delete, not delete exactly one.
    observe("heldbksp", lambda: longpress(*g["bksp"], 1400))
    # Swipe-left on backspace: Gboard's word delete, one event removing many
    # chars. Re-seed first — heldbksp above may have emptied the field, and
    # "deleted nothing from nothing" is not a result.
    for _ in range(4):
        if kb_up(): tap(*a, 0.5)
    observe("worddel", lambda: swipe(g["bksp"][0], g["bksp"][1], x0 + 0.45 * W, g["bksp"][1], 260))
    # Long-press a vowel: the accent picker (á à â) — the LatAm/pt-BR path.
    observe("longpress-a", lambda: longpress(*a, 900))

    print(f"  {label:<34} " + "  ".join(res))

if __name__ == "__main__":
    targets = [l.strip() for l in adb("shell", "ime", "list", "-s", "-a").splitlines() if l.strip()]
    # MIUI's security IME is excluded: it is a Xiaomi system component that only
    # behaves correctly inside the MIUI framework, so a result here says nothing
    # about real devices.
    SKIP = ("googletts", "com.miui.securityinputmethod")
    targets = [t for t in targets if not any(k in t for k in SKIP)]
    only = sys.argv[1:]
    for ime in targets:
        short = ime.split("/")[0].split(".")[-1]
        if only and not any(o in ime for o in only): continue
        try:
            run(ime, short)
        except Exception as e:
            print(f"  {short:<34} ERROR {type(e).__name__}: {e}")
