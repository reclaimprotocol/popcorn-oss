import { spawn, execFile, type ChildProcess } from "node:child_process";
import { ADB, adbArgs } from "./adb.js";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface EmulatorConfig {
  avd: string;
  /** `swiftshader_indirect` in a pod; `host` only where a GPU is passed in. */
  gpu: string;
  serial: string;
  bootTimeoutMs: number;
  extraArgs: string[];
  /**
   * `spawn` runs the emulator in this process's own environment. `attach` uses
   * a device that already exists and never starts or stops one - which is how
   * this runs on Apple Silicon, where the emulator lives on the macOS host
   * because Google ships none for Linux/arm64.
   */
  mode: "spawn" | "attach";
  /** Start from a clean userdata image. Correct for a session pod, and
   *  destructive anywhere an AVD is meant to keep its state. */
  wipeData: boolean;
}

/**
 * The emulator this pod exists to run.
 *
 * One pod, one emulator, one session. There is no pool here - Agones owns
 * replica count, and the Fleet is what "many devices" means. The emulator needs
 * `/dev/kvm`; without it QEMU falls back to software CPU emulation, which is
 * slow enough to look broken, so the runtime checks for the device up front and
 * says so rather than appearing to hang.
 */
export class Emulator {
  private child?: ChildProcess;
  private log = "";

  constructor(private readonly config: EmulatorConfig) {}

  get logTail(): string {
    return this.log.slice(-4000);
  }

  /** Whether this host can hardware-accelerate the guest.
   *
   *  Only Linux uses KVM. macOS accelerates through Hypervisor.framework with
   *  no device node to look for, so asking about `/dev/kvm` there would report
   *  a problem that does not exist. */
  static accelerationAvailable(): boolean {
    if (process.platform !== "linux") return true;
    return existsSync("/dev/kvm");
  }

  start(): void {
    if (this.config.mode === "attach") return;
    const args = [
      "-avd",
      this.config.avd,
      "-no-window",
      "-no-boot-anim",
      "-no-snapshot-save",
      "-gpu",
      this.config.gpu,
      "-netdelay",
      "none",
      "-netspeed",
      "full",
      ...(this.config.wipeData ? ["-wipe-data"] : []),
      ...this.config.extraArgs,
    ];
    this.child = spawn("emulator", args, { stdio: ["ignore", "pipe", "pipe"] });
    const record = (chunk: Buffer) => {
      this.log = (this.log + chunk.toString("utf8")).slice(-64_000);
    };
    this.child.stdout?.on("data", record);
    this.child.stderr?.on("data", record);
  }

  async waitForBoot(): Promise<void> {
    const deadline = Date.now() + this.config.bootTimeoutMs;
    while (Date.now() < deadline) {
      // In attach mode there is no child to have died; the only question is
      // whether the device is there and finished booting.
      if (this.config.mode === "spawn" && this.child?.exitCode != null) {
        throw new Error(`emulator exited (${this.child.exitCode}): ${this.logTail}`);
      }
      const booted = await this.probe("getprop sys.boot_completed");
      if (booted === "1") return;
      await sleep(2000);
    }
    throw new Error(`emulator did not boot in ${this.config.bootTimeoutMs}ms: ${this.logTail}`);
  }

  async stop(): Promise<void> {
    // An attached emulator belongs to whoever started it; stopping it here
    // would take away a device the operator is still using.
    if (this.config.mode === "attach" || !this.child) return;
    // The console kill is the clean path; emulators sharing a host abort each
    // other when signalled, and a pod restart should not depend on luck.
    try {
      await execFileAsync(ADB, adbArgs(this.config.serial, "emu", "kill"), { timeout: 10_000 });
    } catch {
      this.child.kill("SIGTERM");
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && this.child.exitCode === null) await sleep(500);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
    this.child = undefined;
  }

  private async probe(command: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        ADB,
        adbArgs(this.config.serial, "shell", command),
        { timeout: 8000 },
      );
      return stdout.trim();
    } catch {
      return null;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
