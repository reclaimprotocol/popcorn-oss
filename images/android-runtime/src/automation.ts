import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Controller, KeyName } from "./control.js";
import { KEYCODES } from "./control.js";
import type { VideoStream } from "./video.js";
import { ADB, adbArgs } from "./adb.js";

const execFileAsync = promisify(execFile);

export interface AutomationConfig {
  serial: string;
  /** Raw `adb shell` over HTTP. Off unless an operator turns it on. */
  allowShell: boolean;
}

/**
 * The session's automation API - what CDP is for a browser pod.
 *
 * The surface is a fixed set of verbs rather than a shell, because a route the
 * gateway will proxy to anyone holding a session token should not also be a way
 * to run arbitrary commands on the node's guest. `allowShell` exists for
 * operators who decide otherwise for their own clusters, and defaults off.
 */
export function automationServer(
  config: AutomationConfig,
  controller: Controller,
  video: VideoStream,
) {
  const routes: Record<string, (body: Body, res: ServerResponse) => Promise<void>> = {
    "GET /healthz": async (_body, res) => json(res, 200, { ok: true }),

    "GET /v1/device": async (_body, res) => {
      const [model, release, sdk] = await Promise.all([
        shell(config, "getprop ro.product.model"),
        shell(config, "getprop ro.build.version.release"),
        shell(config, "getprop ro.build.version.sdk"),
      ]);
      json(res, 200, {
        serial: config.serial,
        model,
        androidRelease: release,
        sdkInt: Number(sdk) || null,
        geometry: video.backlog().geometry ?? null,
      });
    },

    "GET /v1/screenshot": async (_body, res) => {
      // `screencap` warns on stdout when a device has several displays, which
      // corrupts the PNG, so the primary display is always named explicitly.
      const displayId = await primaryDisplayId(config);
      const args = adbArgs(config.serial, "exec-out", "screencap", "-p");
      if (displayId) args.push("-d", displayId);
      const { stdout } = await execFileAsync(ADB, args, {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      res.writeHead(200, { "content-type": "image/png" }).end(stdout);
    },

    "GET /v1/ui": async (_body, res) => {
      // `uiautomator dump` waits for the window to go idle and gives up with
      // "could not get idle state" on a screen that animates. The old file is
      // deleted first so a failure can never be served as a fresh tree, and
      // the attempt is retried because the condition is usually transient.
      const path = "/sdcard/popcorn-ui.xml";
      await shell(config, `rm -f ${path}`).catch(() => {});
      let lastError = "";
      for (let attempt = 0; attempt < 4; attempt++) {
        const out = await shell(config, `uiautomator dump ${path} 2>&1`, 30_000).catch(
          (error: unknown) => String(error),
        );
        if (!/ERROR|Exception/i.test(out)) {
          const xml = await shell(config, `cat ${path}`, 30_000).catch(() => "");
          if (xml.startsWith("<?xml")) {
            return void res
              .writeHead(200, { "content-type": "application/xml" })
              .end(xml);
          }
        }
        lastError = out.trim();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      json(res, 503, {
        error: "could not capture the accessibility tree",
        detail: lastError,
      });
    },

    "POST /v1/tap": async (body, res) => {
      const { x, y } = body as { x?: number; y?: number };
      if (!finite(x) || !finite(y)) return json(res, 400, { error: "x and y are required" });
      controller.tap(x, y);
      json(res, 202, { ok: true });
    },

    "POST /v1/swipe": async (body, res) => {
      const b = body as { x1?: number; y1?: number; x2?: number; y2?: number; duration?: number };
      if (![b.x1, b.y1, b.x2, b.y2].every(finite)) {
        return json(res, 400, { error: "x1, y1, x2 and y2 are required" });
      }
      controller.swipe(b.x1!, b.y1!, b.x2!, b.y2!, b.duration ?? 120);
      json(res, 202, { ok: true });
    },

    "POST /v1/key": async (body, res) => {
      const { name, code } = body as { name?: string; code?: number };
      if (typeof name === "string" && name in KEYCODES) controller.key(name as KeyName);
      else if (finite(code)) controller.keycode(code);
      else return json(res, 400, { error: `name must be one of ${Object.keys(KEYCODES).join(", ")}` });
      json(res, 202, { ok: true });
    },

    "POST /v1/text": async (body, res) => {
      const { value } = body as { value?: string };
      if (typeof value !== "string") return json(res, 400, { error: "value is required" });
      controller.text(value);
      json(res, 202, { ok: true });
    },

    "POST /v1/launch": async (body, res) => {
      const { package: pkg } = body as { package?: string };
      if (!isPackageId(pkg)) return json(res, 400, { error: "a package id is required" });
      const out = await shell(config, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
      json(res, 202, { ok: true, output: out });
    },

    "POST /v1/intent": async (body, res) => {
      // Spider sessions arrive this way: component plus string extras.
      const b = body as { component?: string; extras?: Record<string, string | boolean> };
      // Activity names carry `$` for nested classes - `.Settings$DeviceInfoActivity`
      // is ordinary, not an injection attempt - and may be package-relative.
      if (!b.component || !/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(b.component)) {
        return json(res, 400, { error: "component must be <package>/<activity>" });
      }
      const extras = Object.entries(b.extras ?? {})
        .map(([key, value]) =>
          typeof value === "boolean"
            ? `--ez ${shellWord(key)} ${value}`
            : `--es ${shellWord(key)} ${shellWord(value)}`,
        )
        .join(" ");
      // The component must be quoted: a nested-class activity carries `$`, and
      // the device shell would otherwise expand it to nothing, silently
      // starting a different activity than the one asked for.
      const out = await shell(config, `am start -n ${shellWord(b.component)} ${extras}`.trim());
      json(res, 202, { ok: true, output: out });
    },

    "POST /v1/shell": async (body, res) => {
      if (!config.allowShell) return json(res, 403, { error: "shell is disabled on this runtime" });
      const { command } = body as { command?: string };
      if (typeof command !== "string") return json(res, 400, { error: "command is required" });
      json(res, 200, { output: await shell(config, command, 60_000) });
    },

    "POST /v1/resync": async (_body, res) => {
      await video.resync();
      json(res, 202, { ok: true });
    },
  };

  return createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const handler = routes[`${req.method} ${path}`];
      if (!handler) return json(res, 404, { error: "not found" });
      try {
        await handler(await readJson(req), res);
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}

type Body = Record<string, unknown>;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPackageId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(value);
}

/** Single-quotes a word for the device shell. */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function shell(config: AutomationConfig, command: string, timeout = 15_000): Promise<string> {
  const { stdout } = await execFileAsync(ADB, adbArgs(config.serial, "shell", command), {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Emulators with more than one display make `screencap` ambiguous. */
async function primaryDisplayId(config: AutomationConfig): Promise<string | null> {
  try {
    const out = await shell(config, "dumpsys SurfaceFlinger --display-id");
    return out.match(/Display (\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Body> {
  if (req.method === "GET") return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) break;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
  } catch {
    return {};
  }
}
