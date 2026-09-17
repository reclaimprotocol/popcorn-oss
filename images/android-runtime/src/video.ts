import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  execOut,
  displayInfo,
  systemBarInsets,
  NO_INSETS,
  type Display,
  type DisplayInfo,
  type Insets,
} from "./adb.js";
import { AnnexBSplitter, type AccessUnit } from "./h264.js";

/** screenrecord refuses a --time-limit above 180s on most builds, and stops on
 *  its own at 180s even without the flag, so the stream is stitched from
 *  back-to-back runs. */
const SEGMENT_SECONDS = 175;
const DISPLAY_POLL_MS = 1500;

export interface VideoOptions {
  /** Longest edge of the encoded frame; the short edge follows the aspect ratio. */
  maxSize: number;
  bitRate: number;
  /** Which display to record; the primary one when absent. */
  display?: Display;
}

export interface StreamGeometry extends DisplayInfo {
  /** Encoded frame size, which is the display scaled down to fit maxSize. */
  encodedWidth: number;
  encodedHeight: number;
  /** Status bar and navigation bar, in display pixels. */
  insets: Insets;
}

export interface VideoStream {
  on(event: "au", listener: (unit: AccessUnit) => void): this;
  on(event: "geometry", listener: (geometry: StreamGeometry) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

/**
 * A continuous H.264 Annex-B stream of a device's screen.
 *
 * Holds the current GOP so a viewer that connects between keyframes can start
 * decoding immediately instead of waiting out screenrecord's I-frame interval.
 */
export class VideoStream extends EventEmitter {
  private child?: ChildProcess;
  private splitter: AnnexBSplitter;
  private restartTimer?: NodeJS.Timeout;
  private displayTimer?: NodeJS.Timeout;
  private stopped = false;
  private gop: AccessUnit[] = [];
  private geometry?: StreamGeometry;

  constructor(
    private readonly serial: string,
    private readonly options: VideoOptions,
  ) {
    super();
    this.splitter = new AnnexBSplitter((unit) => this.handleAccessUnit(unit));
  }

  /** Everything a new viewer needs to decode from this moment: parameter sets,
   *  then the current GOP starting at its keyframe. */
  backlog(): { parameterSets?: Buffer; units: AccessUnit[]; geometry?: StreamGeometry } {
    return {
      parameterSets: this.splitter.parameterSets,
      units: this.gop.slice(),
      geometry: this.geometry,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.spawnSegment();
    this.displayTimer = setInterval(() => void this.checkDisplay(), DISPLAY_POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.displayTimer);
    this.child?.kill("SIGKILL");
    this.child = undefined;
  }

  /** Tears the current segment down and starts a fresh one; the next access
   *  unit is a keyframe, so viewers recover within a frame. */
  async resync(): Promise<void> {
    if (this.stopped) return;
    clearTimeout(this.restartTimer);
    this.child?.kill("SIGKILL");
    this.child = undefined;
    await this.spawnSegment();
  }

  private async spawnSegment(): Promise<void> {
    if (this.stopped) return;

    let info: DisplayInfo;
    try {
      info = await displayInfo(this.serial, this.options.display);
    } catch (error) {
      this.emit("error", asError(error));
      this.scheduleRetry();
      return;
    }

    const { encodedWidth, encodedHeight } = fitWithin(info.width, info.height, this.options.maxSize);
    const insets = await systemBarInsets(
      this.serial,
      info,
      this.options.display?.logicalId ?? 0,
    ).catch(() => ({ ...NO_INSETS }));
    this.geometry = { ...info, encodedWidth, encodedHeight, insets };
    this.emit("geometry", this.geometry);

    // A new segment always opens with an IDR, so the old GOP is dead weight.
    this.gop = [];
    this.splitter = new AnnexBSplitter((unit) => this.handleAccessUnit(unit));

    // screenrecord addresses displays by physical id, not by the logical id
    // everything else uses.
    const displayArgs = this.options.display
      ? [`--display-id=${this.options.display.physicalId}`]
      : [];
    const child = execOut(this.serial, [
      "screenrecord",
      "--output-format=h264",
      ...displayArgs,
      `--size=${encodedWidth}x${encodedHeight}`,
      `--bit-rate=${this.options.bitRate}`,
      `--time-limit=${SEGMENT_SECONDS}`,
      "-",
    ]);
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.splitter.push(chunk));

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => this.emit("error", error));
    child.on("close", (code) => {
      if (this.child !== child) return; // superseded by resync()
      this.child = undefined;
      if (this.stopped) return;
      if (code !== 0 && stderr.trim()) {
        this.emit("error", new Error(`screenrecord: ${stderr.trim()}`));
      }
      // Reaching the time limit is the normal path; so is a mid-stream failure.
      // Both are answered the same way.
      this.scheduleRetry(code === 0 ? 0 : 1000);
    });
  }

  private scheduleRetry(delayMs = 1000): void {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.spawnSegment(), delayMs);
  }

  private handleAccessUnit(unit: AccessUnit): void {
    if (unit.keyframe) this.gop = [unit];
    else if (this.gop.length > 0) this.gop.push(unit);
    // Bound the backlog: a stalled encoder must not grow it without limit.
    if (this.gop.length > 600) this.gop.length = 600;
    this.emit("au", unit);
  }

  /**
   * screenrecord fixes the encoded frame size when it starts, so any change to
   * the display invalidates the segment - not just rotation. A resizable AVD
   * switching between phone, foldable and tablet changes the size with the
   * rotation unchanged, which is why this compares all three.
   */
  private async checkDisplay(): Promise<void> {
    if (this.stopped || !this.geometry) return;
    try {
      const info = await displayInfo(this.serial, this.options.display);
      const current = this.geometry;
      const changed =
        info.rotation !== current.rotation ||
        info.width !== current.width ||
        info.height !== current.height;
      if (changed) await this.resync();
    } catch {
      // A transient adb hiccup is not worth tearing the stream down for.
    }
  }
}

/** Scales to fit `maxSize` on the long edge, rounded to even numbers because
 *  H.264 chroma subsampling needs them. */
export function fitWithin(
  width: number,
  height: number,
  maxSize: number,
): { encodedWidth: number; encodedHeight: number } {
  const longEdge = Math.max(width, height);
  const scale = longEdge > maxSize ? maxSize / longEdge : 1;
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { encodedWidth: even(width), encodedHeight: even(height) };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
