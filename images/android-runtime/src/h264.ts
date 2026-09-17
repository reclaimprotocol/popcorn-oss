/** Minimal Annex-B splitter: enough to group screenrecord's output into access
 *  units and to recognise the parameter sets a late-joining decoder needs.
 *
 *  screenrecord emits exactly one VCL NAL per picture, so "a picture ends at
 *  every VCL NAL" is sound here. It is not sound for multi-slice encoders. */

export const NAL_SLICE = 1;
export const NAL_IDR = 5;
export const NAL_SEI = 6;
export const NAL_SPS = 7;
export const NAL_PPS = 8;

export interface AccessUnit {
  /** Annex-B bytes, start codes included, ready for a WebCodecs chunk. */
  data: Bytes;
  keyframe: boolean;
}

/** `Buffer.subarray` and `Buffer.concat` widen the backing store, so the
 *  buffers passed around inside the splitter are typed loosely. */
export type Bytes = Buffer<ArrayBufferLike>;

export function nalType(nal: Bytes): number {
  return nal.length > 0 ? (nal[0]! & 0x1f) : 0;
}

/** Feeds on chunks of a raw Annex-B stream and calls back once per access unit. */
export class AnnexBSplitter {
  private tail: Bytes = Buffer.alloc(0);
  private pending: Bytes[] = [];
  /** Latest SPS/PPS seen, replayed to viewers that join mid-stream. */
  private sps?: Bytes;
  private pps?: Bytes;

  constructor(private readonly onAccessUnit: (unit: AccessUnit) => void) {}

  /** SPS+PPS as Annex-B, or undefined before the first one arrives. */
  get parameterSets(): Bytes | undefined {
    if (!this.sps || !this.pps) return undefined;
    return Buffer.concat([startCode(), this.sps, startCode(), this.pps]);
  }

  push(chunk: Bytes): void {
    const buffer = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;

    // Offsets of every start code in the buffer.
    const starts: Array<{ at: number; size: 3 | 4 }> = [];
    for (let i = 0; i + 2 < buffer.length; i++) {
      if (buffer[i] !== 0 || buffer[i + 1] !== 0) continue;
      if (buffer[i + 2] === 1) {
        starts.push({ at: i, size: 3 });
        i += 2;
      } else if (buffer[i + 2] === 0 && buffer[i + 3] === 1) {
        starts.push({ at: i, size: 4 });
        i += 3;
      }
    }

    if (starts.length === 0) {
      this.tail = buffer;
      return;
    }

    // Every NAL except the last complete one; the bytes from the final start
    // code onward are held back because more of that NAL may still arrive.
    for (let i = 0; i + 1 < starts.length; i++) {
      const from = starts[i]!;
      const to = starts[i + 1]!;
      this.consume(buffer.subarray(from.at + from.size, to.at));
    }
    this.tail = buffer.subarray(starts.at(-1)!.at);
  }

  /** Flushes whatever is buffered; call when the underlying process ends. */
  reset(): void {
    this.tail = Buffer.alloc(0);
    this.pending = [];
  }

  private consume(nal: Bytes): void {
    if (nal.length === 0) return;
    const type = nalType(nal);
    if (type === NAL_SPS) this.sps = Buffer.from(nal);
    if (type === NAL_PPS) this.pps = Buffer.from(nal);

    this.pending.push(nal);

    if (type === NAL_SLICE || type === NAL_IDR) {
      const keyframe = this.pending.some((n) => nalType(n) === NAL_IDR);
      const parts: Bytes[] = [];
      for (const n of this.pending) {
        parts.push(startCode(), n);
      }
      this.pending = [];
      this.onAccessUnit({ data: Buffer.concat(parts), keyframe });
    }
  }
}

function startCode(): Buffer {
  return Buffer.from([0, 0, 0, 1]);
}
