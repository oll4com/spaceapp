import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { idSchema } from "@space/contracts";
import { z } from "zod";
import { childProcessEnv } from "./child-process-env.js";
import { execFile, spawn } from "./safe-child-process.js";

/**
 * Browser sound reaches the operator only from the panes a Space tab says are audible (operator 2/11 14:22 BKK: a Twitch
 * tab nobody looked at played on their computer). Every managed Chrome plays into one PulseAudio sink that the audio
 * socket records, so each Chrome stream whose Chrome holds none of the audible panes is muted at the source, every one
 * while no audio socket is open; a stream Space cannot tie to a managed Chrome is left alone.
 * shortcut: per Chrome, not per tab (Chrome has no tab-mute in CDP); panes on one Google account share a Chrome, so a
 * sibling pane on the audible pane's account stays audible. Upgrade with per-Chrome sinks if that ever matters.
 */
export interface BrowserAudioMuteDeps {
  pactl(args: string[]): Promise<string>;
  /** Calls back when a new sink input appears; returns its stop. */
  watch(onNew: () => void): () => void;
  /** The `--user-data-dir` of the Chrome that owns this process, or null. */
  chromeProfileOf(pid: number): Promise<string | null>;
  /** Chrome profile directories holding these panes' browsers. */
  profilesOf(paneIds: string[]): Promise<string[]>;
  warn(message: string): void;
}

interface SinkInput { index: number; mute: boolean; properties?: Record<string, string> }

export function createBrowserAudioMute(deps: BrowserAudioMuteDeps) {
  const holders = new Map<symbol, string[]>();
  let running: Promise<void> | null = null;
  let again = false;

  async function apply() {
    const held = [...new Set([...holders.values()].flat())];
    const audible = new Set(held.length ? (await deps.profilesOf(held)).map((path) => resolve(path)) : []);
    const inputs = JSON.parse(await deps.pactl(["-f", "json", "list", "sink-inputs"])) as SinkInput[];
    for (const input of inputs) {
      const pid = Number(input.properties?.["application.process.id"]);
      const profile = Number.isInteger(pid) && pid > 1 ? await deps.chromeProfileOf(pid) : null;
      if (!profile) continue;
      const mute = !audible.has(resolve(profile));
      if (input.mute !== mute) await deps.pactl(["set-sink-input-mute", String(input.index), mute ? "1" : "0"]);
    }
  }

  function schedule() {
    if (running) { again = true; return; }
    running = apply()
      .catch((error: unknown) => deps.warn(`Browser audio mute failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = null; if (again) { again = false; schedule(); } });
  }

  // Watch from the start, so a stream that begins while nobody listens is muted too.
  const unwatch = deps.watch(schedule);
  schedule();

  return {
    /** One per open audio socket: the panes it plays; release when the socket closes. */
    hold(paneIds: string[]) {
      const key = Symbol();
      holders.set(key, paneIds);
      schedule();
      return {
        update(next: string[]) { if (holders.has(key)) { holders.set(key, next); schedule(); } },
        release() { holders.delete(key); schedule(); }
      };
    },
    async idle() { while (running) await running; },
    stop() { unwatch(); }
  };
}

export function pulseBrowserAudioMuteDeps(pulseServer: string, profilesOf: BrowserAudioMuteDeps["profilesOf"]): BrowserAudioMuteDeps {
  const env = { ...childProcessEnv(), PULSE_SERVER: pulseServer };
  let warned = false;
  return {
    pactl: (args) => new Promise((done, fail) => {
      execFile("pactl", args, { env, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? fail(error) : done(stdout));
    }),
    watch(onNew) {
      let stopped = false;
      let child: ReturnType<typeof spawn> | null = null;
      const start = () => {
        child = spawn("pactl", ["subscribe"], { env, stdio: ["ignore", "pipe", "ignore"] });
        child.on("error", () => undefined);
        // A dead subscription would let new streams play unmuted: start it again and re-check.
        child.on("exit", () => { if (!stopped) setTimeout(() => { if (!stopped) { start(); onNew(); } }, 2_000).unref(); });
        child.stdout?.setEncoding("utf8").on("data", (text: string) => { if (/'new' on sink-input/.test(text)) onNew(); });
      };
      start();
      return () => { stopped = true; child?.kill("SIGTERM"); };
    },
    async chromeProfileOf(pid) {
      // The audio service runs unsandboxed in the host's PID namespace and carries the profile; walk up once or twice otherwise.
      for (let current = pid, hops = 0; current > 1 && hops < 3; hops++) {
        const args = (await readFile(`/proc/${current}/cmdline`, "utf8").catch(() => "")).split("\0");
        const dir = args.find((arg) => arg.startsWith("--user-data-dir="));
        if (dir) return dir.slice("--user-data-dir=".length);
        const stat = await readFile(`/proc/${current}/stat`, "utf8").catch(() => "");
        current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      }
      return null;
    },
    profilesOf,
    warn(message) { if (!warned) { warned = true; console.warn(message); } }
  };
}

const audibleMessageSchema = z.object({ type: z.literal("audible"), paneIds: z.array(idSchema).max(64) });

/** The panes a Space tab plays now, from its audio socket's `{"type":"audible","paneIds":[…]}`; null for anything else. */
export function audibleMessagePaneIds(raw: string): string[] | null {
  try {
    const parsed = audibleMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? [...new Set(parsed.data.paneIds)] : null;
  } catch {
    return null;
  }
}
