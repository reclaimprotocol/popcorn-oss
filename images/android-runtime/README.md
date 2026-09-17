# Android runtime

An Android emulator as a Popcorn session pod. Where `browser-runtime` gives a
session a Chromium instance with a live view and CDP, this gives it a device
with a live view and an automation API.

Everything around it is unchanged: the control plane admits the session, the
pool manager allocates from an Agones fleet and writes the routes, and the
gateway proxies to this pod after validating the signed path token.

| | browser-runtime | android-runtime |
| --- | --- | --- |
| Live view | VNC on 6080 | H.264 over WebSocket on 6080 |
| Control | CDP on 9222 | REST automation API on 3000 |
| Needs | `SYS_ADMIN` | `/dev/kvm` |

## Live view

The device's own encoder produces H.264, which is relayed to the browser and
decoded with WebCodecs onto a canvas - no transcode anywhere in the path. The
server holds the current GOP, so a viewer arriving between keyframes starts
drawing immediately rather than waiting out the encoder's I-frame interval.

Input travels as normalised coordinates and is injected with `input`. A short,
near-stationary press is a tap; anything else is a swipe carrying its real
duration, so long-press and fling both behave.

There is no authentication on this port, deliberately. The gateway validates the
session token before proxying and the network policy admits only the gateway. A
second check here would be theatre and a second thing to get wrong - but it does
mean **the network policy is load-bearing**, not hygiene.

## Automation API

`POST` unless noted. Coordinates are device pixels.

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Liveness |
| `GET /v1/device` | Serial, model, Android version, current geometry |
| `GET /v1/screenshot` | PNG of the primary display |
| `GET /v1/ui` | `uiautomator` XML of the accessibility tree |
| `/v1/tap` | `{ x, y }` |
| `/v1/swipe` | `{ x1, y1, x2, y2, duration? }` |
| `/v1/key` | `{ name }` or `{ code }` |
| `/v1/text` | `{ value }` |
| `/v1/launch` | `{ package }` |
| `/v1/intent` | `{ component, extras }` - how a Spider session is dispatched |
| `/v1/shell` | `{ command }` - **disabled unless `AUTOMATION_ALLOW_SHELL=true`** |
| `/v1/resync` | Restart the video segment |

The surface is a fixed set of verbs rather than a shell because anything the
gateway will proxy to a session-token holder should not also run arbitrary
commands in the guest. `AUTOMATION_ALLOW_SHELL` exists for operators who decide
otherwise about their own clusters.

`GET /v1/screenshot` always names the display explicitly: `screencap` prints a
warning to stdout when a device has more than one, which corrupts the PNG.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANDROID_AVD_NAME` | `popcorn` | AVD baked into the image |
| `ANDROID_SERIAL` | `emulator-5554` | adb serial |
| `ANDROID_GPU_MODE` | `swiftshader_indirect` | `host` only where a GPU is passed in |
| `LIVEVIEW_PORT` | `6080` | Must match the Fleet port |
| `AUTOMATION_PORT` | `3000` | Must match the extension route |
| `STREAM_MAX_SIZE` | `1080` | Longest edge of the encoded frame |
| `STREAM_BITRATE` | `6000000` | Video bitrate |
| `BOOT_TIMEOUT_SECONDS` | `300` | Boot budget |
| `LIVEVIEW_READ_ONLY` | `false` | Stream without accepting input |
| `AUTOMATION_ALLOW_SHELL` | `false` | Enable `/v1/shell` |
| `EMULATOR_WIPE_DATA` | `true` | Fresh userdata per pod |
| `EMULATOR_MODE` | `spawn` | `attach` to use a device that already exists |
| `ADB_SERVER_HOST` | | Reach an adb server on another machine |
| `ADB_SERVER_PORT` | `5037` | Port of that server |
| `REQUIRE_KVM` | `true` | Refuse to start without `/dev/kvm` |

`EMULATOR_WIPE_DATA` is what stops one session's state reaching the next. It is
also destructive, so set it `false` when attaching to an AVD you want to keep.

## Hard requirements

**`/dev/kvm`.** Without it QEMU emulates the CPU in software and the device is
slow enough to read as a hang rather than a misconfiguration, which is why the
entrypoint refuses to start by default. `charts/android-fleet` requests the
device through a plugin so pods stay unprivileged.

**x86_64, and therefore x86 apps.** GCE offers nested virtualization on Intel
hosts only. An arm64 guest on Arm nodes has no KVM, so the image is x86_64 - and
every app a provider pins needs an x86 build. This is the constraint most likely
to block a given provider, so check it before building a node pool.

**Boot time.** Minutes, not seconds. The fleet autoscaler's `bufferSize` is what
makes a session feel immediate: it is the count of devices already warm and
unallocated.

## Baking apps in

The pod installs nothing at runtime, so apps a provider pins go in at build
time. Drop APKs into `apks/` before building. Reinstalling at runtime would also
break Spider: `adb install -r` kills its accessibility service and Android keeps
the dead binding, so the service reads nothing afterwards.

## Attach mode, and running on Apple Silicon

`EMULATOR_MODE=attach` uses a device that already exists instead of starting
one, and never stops it - the device belongs to whoever started it. With
`ADB_SERVER_HOST` that device can be on another machine entirely.

This is the only way to containerise the runtime on Apple Silicon. Google
publishes the emulator for linux/x64, macosx/x64, macosx/aarch64 and
windows/x64 - there is **no linux/aarch64 build** - so on an Arm Linux
container the device cannot be inside it, whatever the host supports. Run the
emulator natively on macOS, where it is fast, and attach:

```sh
# on the host: let the adb server take connections from the container.
# -a binds every interface, so do not leave this running on a shared network.
adb kill-server && adb -a -P 5037 nodaemon server &

docker build -f Dockerfile.attach -t popcorn/android-runtime:attach .
docker run --rm -p 6080:6080 -p 3000:3000 \
  --add-host host.docker.internal:host-gateway \
  -e ADB_SERVER_HOST=host.docker.internal \
  -e ANDROID_SERIAL=emulator-5554 \
  popcorn/android-runtime:attach
```

`Dockerfile.attach` carries no Android SDK and is architecture-neutral. The
same mode points the runtime at a farm of physical devices over adb TCP, which
is the case hardware attestation actually needs - an emulator has no TEE.

## Running it outside Kubernetes

The runtime notices there is no Agones sidecar and carries on, which makes it
directly runnable against a local emulator:

```sh
npm install && npm run build
PATH="$ANDROID_HOME/emulator:$PATH" \
ANDROID_AVD_NAME=my_avd EMULATOR_WIPE_DATA=false \
  node dist/index.js
```

Then the live view is on <http://localhost:6080> and the API on `:3000`.
