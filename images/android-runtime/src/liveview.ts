import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { VideoStream, type StreamGeometry } from "./video.js";
import { Controller, KEYCODES, type KeyName } from "./control.js";
import type { AccessUnit } from "./h264.js";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * The session's live view, on the port Popcorn reserves for it.
 *
 * Authentication is deliberately absent. The gateway validates the signed path
 * token before it proxies anything here, and the network policy admits only the
 * gateway, so a second check on this port would be theatre - and a second place
 * to get wrong. The pod is reachable by nothing else.
 */
export class LiveView {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly viewers = new Set<WebSocket>();
  private geometry?: StreamGeometry;

  constructor(
    private readonly video: VideoStream,
    private readonly controller: Controller,
    private readonly readOnly: boolean,
  ) {
    this.video.on("au", (unit: AccessUnit) => this.broadcastVideo(unit));
    this.video.on("geometry", (geometry: StreamGeometry) => {
      this.geometry = geometry;
      this.broadcast({ type: "geometry", geometry });
    });
    this.video.on("error", (error: Error) =>
      this.broadcast({ type: "notice", level: "error", text: error.message }),
    );
  }

  listen(port: number, host = "0.0.0.0") {
    const http = createServer((req, res) => void this.handleHttp(req, res));
    http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // `/websockify` is where Popcorn's gateway forwards `/liveview-ws/...`,
      // a name inherited from noVNC. `/ws` is what a direct connection uses.
      if (url.pathname !== "/ws" && url.pathname !== "/websockify") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });
    http.listen(port, host);
    return http;
  }

  private attach(ws: WebSocket): void {
    this.viewers.add(ws);
    ws.send(JSON.stringify({ type: "hello", readOnly: this.readOnly, geometry: this.geometry }));

    const backlog = this.video.backlog();
    if (backlog.geometry) {
      ws.send(JSON.stringify({ type: "geometry", geometry: backlog.geometry }));
    }
    if (backlog.parameterSets) ws.send(frame(backlog.parameterSets, true, true), { binary: true });
    for (const unit of backlog.units) ws.send(frame(unit.data, unit.keyframe, false), { binary: true });

    // The device encoder only produces frames when the screen changes, so a
    // viewer arriving at a still screen would otherwise wait - possibly
    // forever - for its first picture. Restarting the segment costs one
    // keyframe and makes the view appear at once.
    if (backlog.units.length === 0) void this.video.resync();

    ws.on("message", (raw, isBinary) => {
      if (isBinary || this.readOnly) return;
      try {
        this.handleInput(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        // A malformed frame from a viewer is not worth closing the socket for.
      }
    });
    ws.on("close", () => this.viewers.delete(ws));
    ws.on("error", () => this.viewers.delete(ws));
  }

  /** Normalised [0,1] against the display in its current rotation. */
  private toDevice(nx: number, ny: number): [number, number] | null {
    if (!this.geometry) return null;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [clamp(nx) * this.geometry.width, clamp(ny) * this.geometry.height];
  }

  private handleInput(message: Record<string, unknown>): void {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    switch (message.type) {
      case "tap": {
        const point = this.toDevice(num(message.x) ?? -1, num(message.y) ?? -1);
        if (point) this.controller.tap(point[0], point[1]);
        return;
      }
      case "swipe": {
        const from = this.toDevice(num(message.x1) ?? -1, num(message.y1) ?? -1);
        const to = this.toDevice(num(message.x2) ?? -1, num(message.y2) ?? -1);
        const duration = Math.min(5000, Math.max(20, num(message.duration) ?? 120));
        if (from && to) this.controller.swipe(from[0], from[1], to[0], to[1], duration);
        return;
      }
      case "key":
        if (typeof message.name === "string" && message.name in KEYCODES) {
          this.controller.key(message.name as KeyName);
        }
        return;
      case "text":
        if (typeof message.value === "string" && message.value.length <= 4096) {
          this.controller.text(message.value);
        }
        return;
      case "resync":
        void this.video.resync();
        return;
      default:
        return;
    }
  }

  private broadcastVideo(unit: AccessUnit): void {
    const payload = frame(unit.data, unit.keyframe, false);
    for (const ws of this.viewers) {
      // A viewer whose socket is backing up is dropped forward to the next
      // keyframe rather than allowed to grow an unbounded buffer.
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) {
        ws.send(payload, { binary: true });
      }
    }
  }

  private broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const ws of this.viewers) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    // Popcorn's pool manager mints live-view URLs ending in `/liveview.html`,
    // so that name is part of the contract a runtime has to meet, not a detail
    // of the browser runtime that happens to use it.
    const isIndex = path === "/" || path === "/liveview.html";
    const file = isIndex ? join(WEB_ROOT, "index.html") : normalize(join(WEB_ROOT, path));
    if (!file.startsWith(WEB_ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  }
}

/** 1-byte header: bit 0 keyframe, bit 1 parameter-sets-only. */
function frame(data: Buffer, keyframe: boolean, config: boolean): Buffer {
  return Buffer.concat([Buffer.from([(keyframe ? 1 : 0) | (config ? 2 : 0)]), data]);
}
