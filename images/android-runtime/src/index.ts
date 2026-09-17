#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Agones } from "./agones.js";
import { ADB, serverArgs } from "./adb.js";
import { Emulator, sleep } from "./emulator.js";
import { VideoStream } from "./video.js";
import { Controller } from "./control.js";
import { LiveView } from "./liveview.js";
import { automationServer } from "./automation.js";

const execFileAsync = promisify(execFile);

const env = {
  avd: process.env.ANDROID_AVD_NAME ?? "popcorn",
  serial: process.env.ANDROID_SERIAL ?? "emulator-5554",
  gpu: process.env.ANDROID_GPU_MODE ?? "swiftshader_indirect",
  liveviewPort: Number(process.env.LIVEVIEW_PORT ?? 6080),
  automationPort: Number(process.env.AUTOMATION_PORT ?? 3000),
  maxSize: Number(process.env.STREAM_MAX_SIZE ?? 1080),
  bitRate: Number(process.env.STREAM_BITRATE ?? 6_000_000),
  bootTimeoutMs: Number(process.env.BOOT_TIMEOUT_SECONDS ?? 300) * 1000,
  readOnly: process.env.LIVEVIEW_READ_ONLY === "true",
  allowShell: process.env.AUTOMATION_ALLOW_SHELL === "true",
  extraArgs: (process.env.EMULATOR_EXTRA_ARGS ?? "").split(" ").filter(Boolean),
  // Nothing on this pod's screen should come from a previous session, so a
  // session pod wipes. Set false when attaching to an AVD you want to keep.
  wipeData: process.env.EMULATOR_WIPE_DATA !== "false",
  mode: (process.env.EMULATOR_MODE ?? "spawn") === "attach" ? ("attach" as const) : ("spawn" as const),
};

function log(message: string): void {
  console.log(`[android-runtime] ${message}`);
}

async function main(): Promise<void> {
  const agones = new Agones();
  const underAgones = await agones.available();
  // Health pings start before the emulator does: booting one takes longer than
  // Agones' failure threshold, and a pod that is still booting is not unhealthy.
  if (underAgones) agones.startHealthLoop();

  if (env.mode === "spawn" && !Emulator.accelerationAvailable()) {
    // Worth saying plainly. Without KVM the emulator still starts, and then
    // behaves so slowly that it reads as a hang rather than a misconfiguration.
    log("WARNING: /dev/kvm is missing - the emulator will fall back to software");
    log("         CPU emulation. Schedule this pod on a node with nested");
    log("         virtualization and a KVM device plugin.");
  }

  const remote = process.env.ADB_SERVER_HOST;
  if (remote) {
    log(`using the adb server at ${remote}:${process.env.ADB_SERVER_PORT ?? "5037"}`);
  } else {
    log("starting adb server");
    await execFileAsync(ADB, [...serverArgs(), "start-server"], { timeout: 30_000 }).catch(() => {});
  }

  const emulator = new Emulator({
    avd: env.avd,
    gpu: env.gpu,
    serial: env.serial,
    bootTimeoutMs: env.bootTimeoutMs,
    extraArgs: env.extraArgs,
    wipeData: env.wipeData,
    mode: env.mode,
  });

  if (env.mode === "attach") {
    log(`attaching to ${env.serial}`);
  } else {
    log(`booting ${env.avd}${env.wipeData ? " (wiping userdata)" : ""}`);
  }
  emulator.start();
  await emulator.waitForBoot();
  log("device ready");

  const controller = new Controller(env.serial);
  controller.start();

  const video = new VideoStream(env.serial, { maxSize: env.maxSize, bitRate: env.bitRate });
  // Video failures otherwise reach viewers as an on-screen notice and nowhere
  // else, so an operator reading `kubectl logs` sees a healthy pod serving a
  // frozen picture.
  video.on("error", (error: Error) => log(`video: ${error.message}`));
  await video.start();

  const liveview = new LiveView(video, controller, env.readOnly);
  liveview.listen(env.liveviewPort);
  log(`liveview on :${env.liveviewPort}`);

  automationServer({ serial: env.serial, allowShell: env.allowShell }, controller, video)
    .listen(env.automationPort, "0.0.0.0");
  log(`automation api on :${env.automationPort}${env.allowShell ? " (shell enabled)" : ""}`);

  // Only now is the pod worth allocating: an Agones GameServer that reports
  // Ready before its emulator is up hands a client a device that is not there.
  if (underAgones) {
    await agones.ready();
    log("reported Ready to Agones");
  } else {
    log("no Agones sidecar; running standalone");
  }

  const shutdown = async (signal: string) => {
    log(`${signal}: shutting down`);
    agones.stopHealthLoop();
    video.stop();
    controller.stop();
    await emulator.stop();
    if (underAgones) await agones.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Hold the process open; the emulator and the servers are the work.
  await new Promise(() => {});
}

main().catch(async (error: unknown) => {
  console.error(`[android-runtime] fatal: ${error instanceof Error ? error.stack : error}`);
  // Give the log a moment to flush before Kubernetes restarts the pod.
  await sleep(500);
  process.exit(1);
});
