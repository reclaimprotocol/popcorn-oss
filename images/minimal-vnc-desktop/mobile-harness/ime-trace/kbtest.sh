# usage: [ANDROID_SERIAL=x] [TAPY=n] kbtest.sh "<name>" ax ay bx by spx spy bsx bsy
NAME="$1"; AX=$2; AY=$3; BX=$4; BY=$5; SPX=$6; SPY=$7; BSX=$8; BSY=$9
D=${ANDROID_SERIAL:-emulator-5554}
TAPY=${TAPY:-1050}
t(){ adb -s $D shell input tap $1 $2; sleep 0.6; }
kbup(){ [ "$(adb -s $D shell dumpsys input_method | grep -m1 -oE 'mInputShown=[a-z]+')" = "mInputShown=true" ]; }
chk(){ python3 /tmp/rcdp.py diag | python3 -c "
import json,sys
p=json.loads(json.load(sys.stdin))['password']; exp=$1; got=p['codePoints']
print('  %-26s %-20s %s' % ('$2', got, 'PASS' if got==exp else 'FAIL exp='+str(exp)))"; }
echo "### $NAME"
# Reset the viewer's proxy buffer via a field change, not by clearing .value.
python3 /tmp/rcdp.py clear >/dev/null
python3 /tmp/rcdp.py focus username >/dev/null; sleep 2
python3 /tmp/rcdp.py focus password >/dev/null; sleep 2
python3 /tmp/rcdp.py clear >/dev/null; sleep 1
# The keyboard needs a real tap gesture and can drop across a focus change.
# Verify it is actually up before typing — otherwise every result is a false FAIL.
for i in 1 2 3 4; do kbup && break; adb -s $D shell input tap 540 $TAPY; sleep 3.5; done
if ! kbup; then echo "  ABORT: keyboard not up — results would be meaningless"; exit 1; fi
F=$(python3 -c "
import json,sys,urllib.request,websocket
v=json.load(urllib.request.urlopen('http://localhost:19226/json/version',timeout=10))
ws=websocket.create_connection(v['webSocketDebuggerUrl'],timeout=20,suppress_origin=True)
i=[0]
def rpc(m,p=None,sid=None):
    i[0]+=1; msg={'id':i[0],'method':m,'params':p or {}}
    if sid: msg['sessionId']=sid
    ws.send(json.dumps(msg))
    while True:
        r=json.loads(ws.recv())
        if r.get('id')==i[0]: return r
pg=[t for t in rpc('Target.getTargets')['result']['targetInfos'] if t['type']=='page'][0]
sid=rpc('Target.attachToTarget',{'targetId':pg['targetId'],'flatten':True})['result']['sessionId']
print(rpc('Runtime.evaluate',{'expression':'document.activeElement.id','returnByValue':True},sid)['result']['result'].get('value'))
ws.close()")
if [ "$F" != "password" ]; then echo "  ABORT: remote focus is '$F', not password"; exit 1; fi
echo "  (keyboard up, remote focus=password)"
t $AX $AY; t $BX $BY; sleep 1.5; chk "[97,98]" "type ab"
t $SPX $SPY; sleep 1.5;             chk "[97,98,32]" "passphrase space"
t $SPX $SPY; sleep 1.5;             chk "[97,98,32,32]" "double space (no period)"
t $BSX $BSY; sleep 1.5;             chk "[97,98,32]" "backspace"
