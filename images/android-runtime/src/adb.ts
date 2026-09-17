import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ADB = process.env.ADB_PATH ?? "adb";

/**
 * Arguments that select which adb server to talk to, before any command.
 *
 * With `ADB_SERVER_HOST` set, adb talks to a server on another machine. That
 * is what lets this runtime drive an emulator running on a macOS host: Google
 * ships no Linux/arm64 emulator, so on Apple Silicon the device has to live
 * outside the container and be reached across the network.
 */
export function serverArgs(): string[] {
  const host = process.env.ADB_SERVER_HOST;
  if (!host) return [];
  return ["-H", host, "-P", process.env.ADB_SERVER_PORT ?? "5037"];
}

/** Full argument list for a device-scoped adb call. */
export function adbArgs(serial: string, ...rest: string[]): string[] {
  return [...serverArgs(), "-s", serial, ...rest];
}

export interface Device {
  serial: string;
  state: string;
  model?: string;
  product?: string;
}

/** `adb devices -l`, parsed. Offline and unauthorized devices are included so the
 *  UI can say why a device it can see is not usable. */
export async function listDevices(): Promise<Device[]> {
  const { stdout } = await execFileAsync(ADB, [...serverArgs(), "devices", "-l"], { timeout: 10_000 });
  const devices: Device[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const tags = Object.fromEntries(
      rest.flatMap((token) => {
        const index = token.indexOf(":");
        return index === -1 ? [] : [[token.slice(0, index), token.slice(index + 1)] as const];
      }),
    );
    devices.push({ serial, state, model: tags.model, product: tags.product });
  }
  return devices;
}

/** One-shot `adb -s <serial> shell <command>`, stdout as a trimmed string. */
export async function shell(serial: string, command: string, timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFileAsync(ADB, adbArgs(serial, "shell", command), {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Raw binary stdout of `adb -s <serial> exec-out <command>` as a child process. */
export function execOut(serial: string, args: string[]) {
  return spawn(ADB, adbArgs(serial, "exec-out", ...args), { stdio: ["ignore", "pipe", "pipe"] });
}

export interface DisplayInfo {
  width: number;
  height: number;
  rotation: number;
}

/**
 * Physical display size and current rotation, in one round trip.
 *
 * `wm size` reports the panel in its natural orientation and never changes, so
 * rotation has to come from the window manager and the pair be swapped by hand.
 * Both are read in a single `adb shell` because this is polled while streaming.
 */
export async function displayInfo(serial: string, display?: Display): Promise<DisplayInfo> {
  if (display && display.logicalId !== 0) {
    // `wm size` only ever speaks for the primary display, so a secondary one
    // is measured from the display manager's own record of it.
    return secondaryDisplayInfo(serial, display);
  }
  const out = await shell(
    serial,
    "wm size; dumpsys window displays | grep -m1 mCurrentRotation",
  );

  // "Physical size: 1080x2400", plus an "Override size:" line that wins when
  // something (a resizable AVD, `wm size`) has changed it.
  const sizes = [...out.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const last = sizes.at(-1);
  if (!last) throw new Error(`could not parse display size from: ${out}`);
  const naturalWidth = Number(last[1]);
  const naturalHeight = Number(last[2]);

  const rotation = parseRotation(out) ?? (await rotationFallback(serial));
  const rotated = rotation === 1 || rotation === 3;
  return {
    width: rotated ? naturalHeight : naturalWidth,
    height: rotated ? naturalWidth : naturalHeight,
    rotation,
  };
}

function parseRotation(text: string): number | null {
  const named = text.match(/ROTATION_(\d)/);
  if (named?.[1]) return Number(named[1]);
  const numeric = text.match(/mCurrentRotation=(\d)/);
  if (numeric?.[1]) return Number(numeric[1]);
  return null;
}

/** `user_rotation` is only the lock setting, so it is the fallback, never the
 *  probe: it is wrong whenever auto-rotate is on. */
async function rotationFallback(serial: string): Promise<number> {
  try {
    const value = Number(await shell(serial, "settings get system user_rotation"));
    if (Number.isInteger(value) && value >= 0 && value <= 3) return value;
  } catch {
    // Some images have no such settings row.
  }
  return 0;
}

/**
 * A display to stream: Android addresses it two different ways, and both are
 * needed - `screenrecord` wants the physical id, while `am start --display`
 * and `input -d` want the logical one.
 */
export interface Display {
  logicalId: number;
  physicalId: string;
  name: string;
  width: number;
  height: number;
  active: boolean;
}

/** Every display the device reports, primary first. */
export async function listDisplays(serial: string): Promise<Display[]> {
  const [viewports, physical] = await Promise.all([
    shell(serial, "dumpsys display | grep -m1 mViewports"),
    shell(serial, "dumpsys SurfaceFlinger --display-id"),
  ]);

  // "Display 4619827259835644672 (HWC display 0): ... displayName=\"EMU_display_0\""
  const byPort = new Map<number, { physicalId: string; name: string }>();
  for (const line of physical.split("\n")) {
    const match = line.match(
      /Display\s+(\d+)\s+\(HWC display\s+(\d+)\).*?displayName="([^"]*)"/,
    );
    if (match) {
      byPort.set(Number(match[2]), { physicalId: match[1]!, name: match[3]! });
    }
  }

  const displays: Display[] = [];
  for (const match of viewports.matchAll(
    /displayId=(\d+),\s*uniqueId='local:(\d+)'.*?physicalPort=(\d+).*?isActive=(true|false)|displayId=(\d+)/g,
  )) {
    if (!match[1]) continue;
    const port = Number(match[3]);
    const entry = byPort.get(port);
    displays.push({
      logicalId: Number(match[1]),
      physicalId: match[2]!,
      name: entry?.name ?? `display ${match[1]}`,
      width: 0,
      height: 0,
      active: match[4] === "true",
    });
  }

  // The viewport line orders by port but does not always carry isActive before
  // the id, so re-read activity from the same line in a second, simpler pass.
  for (const display of displays) {
    const segment = viewports.match(
      new RegExp(`displayId=${display.logicalId},[^}]*`),
    )?.[0];
    if (!segment) continue;
    display.active = !/isActive=false/.test(segment);
    const frame = segment.match(/logicalFrame=Rect\(\d+, \d+ - (\d+), (\d+)\)/);
    if (frame) {
      display.width = Number(frame[1]);
      display.height = Number(frame[2]);
    }
  }
  return displays;
}

async function secondaryDisplayInfo(serial: string, display: Display): Promise<DisplayInfo> {
  const displays = await listDisplays(serial);
  const live = displays.find((d) => d.logicalId === display.logicalId) ?? display;
  const rotation = await displayRotation(serial, display.logicalId);
  return { width: live.width, height: live.height, rotation };
}

async function displayRotation(serial: string, logicalId: number): Promise<number> {
  try {
    const out = await shell(
      serial,
      `dumpsys display | grep -m1 "displayId=${logicalId}," | grep -o "orientation=[0-9]"`,
    );
    const match = out.match(/orientation=(\d)/);
    if (match?.[1]) return Number(match[1]);
  } catch {
    // Fall through: a secondary display that will not say is almost always 0.
  }
  return 0;
}

/** 0/1/2/3 quarter turns, or 0 when the device will not say. */
export async function currentRotation(serial: string): Promise<number> {
  return (await displayInfo(serial)).rotation;
}

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export const NO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * Where the status bar and navigation bar sit, in display pixels.
 *
 * Read from the window manager's own `InsetsSource` frames rather than from
 * resource dimensions, because those are the live rectangles - they follow
 * rotation, and they report `visible=false` when an app goes fullscreen.
 * A bar is turned into an inset only on the edge it actually hugs, so a
 * landscape navigation bar on the right does not get mistaken for a bottom one.
 */
export async function systemBarInsets(
  serial: string,
  display: DisplayInfo,
  logicalId = 0,
): Promise<Insets> {
  // A secondary display carries no status or navigation bar of its own.
  if (logicalId !== 0) return { ...NO_INSETS };
  let out: string;
  try {
    out = await shell(serial, "dumpsys window | grep -m8 'InsetsSource id='");
  } catch {
    return { ...NO_INSETS };
  }

  const insets: Insets = { ...NO_INSETS };
  const seen = new Set<string>();

  for (const line of out.split("\n")) {
    const match = line.match(
      /type=(statusBars|navigationBars)\s+frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]\s+visible=(true|false)/,
    );
    if (!match) continue;
    const [, type, l, t, r, b, visible] = match;
    // Several windows report the same source; the first is enough.
    if (seen.has(type!)) continue;
    seen.add(type!);
    if (visible !== "true") continue;

    const left = Number(l);
    const top = Number(t);
    const right = Number(r);
    const bottom = Number(b);
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) continue;

    // A bar spans the edge it belongs to, so the short dimension says which.
    if (width >= height) {
      if (top <= 0) insets.top = Math.max(insets.top, height);
      else if (bottom >= display.height) insets.bottom = Math.max(insets.bottom, height);
    } else {
      if (left <= 0) insets.left = Math.max(insets.left, width);
      else if (right >= display.width) insets.right = Math.max(insets.right, width);
    }
  }
  return insets;
}

export async function deviceName(serial: string): Promise<string> {
  try {
    const [brand, model] = await Promise.all([
      shell(serial, "getprop ro.product.brand"),
      shell(serial, "getprop ro.product.model"),
    ]);
    const name = [brand, model].filter(Boolean).join(" ").trim();
    return name || serial;
  } catch {
    return serial;
  }
}

/** Serials adb currently reports in the `device` state. */
export async function readySerials(): Promise<string[]> {
  const { stdout } = await execFileAsync(ADB, [...serverArgs(), "devices"], { timeout: 10_000 });
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial!);
}
