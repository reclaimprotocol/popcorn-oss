import { spawn, type ChildProcess } from "node:child_process";
import { ADB, adbArgs } from "./adb.js";

/** Android KeyEvent codes for the buttons the toolbar exposes. */
export const KEYCODES = {
  back: 4,
  home: 3,
  appSwitch: 187,
  power: 26,
  volumeUp: 24,
  volumeDown: 25,
  enter: 66,
  backspace: 67,
  tab: 61,
  escape: 111,
  dpadUp: 19,
  dpadDown: 20,
  dpadLeft: 21,
  dpadRight: 22,
  menu: 82,
  notification: 83,
} as const;

export type KeyName = keyof typeof KEYCODES;

/**
 * Input injection over one long-lived `adb shell`.
 *
 * Keeping the shell open removes the adb connection setup from every tap, which
 * is most of the round trip. The `input` command it runs is still a fresh JVM
 * on the device each time, so expect roughly 80-150ms per event; this is the
 * ceiling of the approach, and the reason `Controller` is an interface that a
 * scrcpy-protocol backend could implement instead.
 */
export class Controller {
  private child?: ChildProcess;
  private restartTimer?: NodeJS.Timeout;
  private stopped = false;

  /** `input -d <logicalId>` targets a secondary display; 0 is the default. */
  constructor(
    private readonly serial: string,
    private readonly displayId = 0,
  ) {}

  private get input(): string {
    return this.displayId === 0 ? "input" : `input -d ${this.displayId}`;
  }

  start(): void {
    this.stopped = false;
    this.spawnShell();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.child?.kill("SIGKILL");
    this.child = undefined;
  }

  tap(x: number, y: number): void {
    this.send(`${this.input} tap ${Math.round(x)} ${Math.round(y)}`);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 120): void {
    const r = Math.round;
    this.send(`${this.input} swipe ${r(x1)} ${r(y1)} ${r(x2)} ${r(y2)} ${r(durationMs)}`);
  }

  key(name: KeyName): void {
    this.send(`${this.input} keyevent ${KEYCODES[name]}`);
  }

  keycode(code: number): void {
    if (!Number.isInteger(code) || code < 0 || code > 1024) return;
    this.send(`${this.input} keyevent ${code}`);
  }

  text(value: string): void {
    // `input text` reads %s as a space and splits on unescaped whitespace, so
    // spaces are encoded and the rest is passed through single quotes.
    const encoded = value.replace(/ /g, "%s");
    this.send(`${this.input} text '${encoded.replace(/'/g, `'\\''`)}'`);
  }

  private send(command: string): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(`${command}\n`);
  }

  private spawnShell(): void {
    if (this.stopped) return;
    const child = spawn(ADB, adbArgs(this.serial, "shell"), {
      stdio: ["pipe", "ignore", "ignore"],
    });
    this.child = child;
    child.on("error", () => this.scheduleRestart(child));
    child.on("close", () => this.scheduleRestart(child));
  }

  private scheduleRestart(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = undefined;
    if (this.stopped) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.spawnShell(), 500);
  }
}
