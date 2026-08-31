# Same sequence, same CDP calls, only the IME differs. If one dismisses and the
# other does not, the IME is the variable — not the harness.
D=emulator-5556
IME="$1"; NAME="$2"; AX=$3; AY=$4; BX=$5; BY=$6; SPX=$7; SPY=$8
kbup(){ [ "$(adb -s $D shell dumpsys input_method | grep -m1 -oE 'mInputShown=[a-z]+')" = "mInputShown=true" ]; }
adb -s $D shell ime set "$IME" >/dev/null 2>&1; sleep 3
python3 /tmp/rcdp.py clear >/dev/null
python3 /tmp/rcdp.py focus username >/dev/null; sleep 2
python3 /tmp/rcdp.py focus password >/dev/null; sleep 2
python3 /tmp/rcdp.py clear >/dev/null; sleep 1
for i in 1 2 3 4; do kbup && break; adb -s $D shell input tap 540 1000; sleep 3.5; done
if ! kbup; then echo "### $NAME -> ABORT (keyboard never came up)"; exit 1; fi
echo "### $NAME"
step(){ adb -s $D shell input tap $2 $3; sleep 1.8
  V=$(python3 /tmp/rcdp.py diag | python3 -c "import json,sys;print(json.loads(json.load(sys.stdin))['password']['codePoints'])")
  echo "    $1 -> $V   kbd=$(kbup && echo up || echo DOWN)"; }
step "a      " $AX $AY
step "b      " $BX $BY
step "space#1" $SPX $SPY
step "space#2" $SPX $SPY
