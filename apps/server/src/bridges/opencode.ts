/**
 * OpenCode bridge (Layer 5) — wrap the OpenCode CLI as a SkillOS target.
 *
 * `/connect opencode` detects whether the `opencode` binary is installed,
 * exposes a curated static capability map, and the registry generates wrappers
 * so an OpenCode capability becomes runnable via `/run opencode-<id>`.
 *
 * AUTH: this bridge proxies to the user's LOCALLY-INSTALLED OpenCode, which
 * carries its OWN provider configuration/auth. It uses the user's existing
 * OpenCode setup — SkillOS does NOT need (and never reads) its own API key for
 * this path. We only spawn the CLI.
 *
 * NON-INTERACTIVE PROXY: OpenCode runs a single non-interactive turn with
 * `opencode run "<prompt>"`, printing the result to stdout instead of opening
 * the interactive TUI. We stream that stdout/stderr back live.
 *
 * GRACEFUL DEGRADATION (hard requirement): if `opencode` is missing, detection
 * never throws — we mark the bridge "unavailable" with an install hint, STILL
 * expose the static capability map (so wrappers are generated), and make run()
 * return ok:false (never throw). The whole mechanism stays verifiable offline.
 *
 * Like every bridge, ALL spawning/parsing lives inside this module.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  Bridge,
  BridgeCapability,
  BridgeCommand,
  BridgeRunResult,
  BridgeSink,
  BridgeStatus,
} from "./types.js";
import { buildCommand, spawnStream } from "./proc.js";

/** Binary we detect/spawn. shell:true so Windows npm shims resolve. */
const BIN = "opencode";

/**
 * Curated static capability map for OpenCode. OpenCode has no stable
 * machine-readable capability API, so we don't scrape `--help`; this tiny static
 * map is the isolated brittle bit. `opencode run` can both answer questions and
 * edit files in the working dir, so we expose `ask` (read-only) and `edit`.
 */
const OPENCODE_CAPABILITIES: BridgeCapability[] = [
  {
    id: "ask",
    description: "Ask OpenCode a question about the codebase (prints the answer)",
    // Treated as read-only chat from SkillOS's perspective — no privileged tools.
    tools: [],
  },
  {
    id: "edit",
    description: "Have OpenCode edit files in the working dir from an instruction",
    // A run that mutates the repo touches the filesystem and may run tools.
    tools: ["filesystem", "shell"],
  },
];

/** Map each capability to a user-facing wrapper command name. */
function deriveCommands(capabilities: BridgeCapability[]): BridgeCommand[] {
  return capabilities.map((cap) => ({
    name: `opencode-${cap.id}`,
    capabilityId: cap.id,
    description: `OpenCode: ${cap.description}`,
  }));
}

const INSTALL_HINT = [
  "opencode (OpenCode) is not installed — the bridge is registered but unavailable.",
  "Install OpenCode: https://opencode.ai",
  "  npm i -g opencode-ai",
  "Then configure a provider and re-run /connect opencode.",
  "Uses your existing OpenCode provider config/auth — no SkillOS API key needed.",
].join("\n");

export interface OpenCodeInfo {
  installed: boolean;
  version: string | null;
}

/**
 * Detect whether `opencode` is on PATH via `opencode --version`. Never throws —
 * a missing binary resolves to { installed: false }. Mirrors detectAider.
 */
export function detectOpenCode(timeoutMs = 12000): Promise<OpenCodeInfo> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (info: OpenCodeInfo) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };

    let child: ChildProcess;
    try {
      child = spawn(BIN, ["--version"], { windowsHide: true, shell: true });
    } catch {
      done({ installed: false, version: null });
      return;
    }

    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => done({ installed: false, version: null }));
    child.on("close", (code) => {
      if (code === 0) {
        // e.g. "1.14.21"
        const m = out.match(/(\d+\.\d+\.\d+\S*)/);
        done({ installed: true, version: m?.[1] ?? (out.trim() || "unknown") });
      } else {
        done({ installed: false, version: null });
      }
    });

    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done({ installed: false, version: null });
    }, timeoutMs);
  });
}

export class OpenCodeBridge implements Bridge {
  readonly name = "opencode";
  readonly description =
    "Proxy SkillOS commands to the OpenCode CLI (uses your OpenCode provider config)";
  status: BridgeStatus = "unavailable";
  note: string | null = INSTALL_HINT;
  readonly capabilities: BridgeCapability[] = OPENCODE_CAPABILITIES;
  readonly commands: BridgeCommand[] = deriveCommands(OPENCODE_CAPABILITIES);

  private version: string | null = null;

  async connect(): Promise<BridgeStatus> {
    const info = await detectOpenCode();
    if (info.installed) {
      this.status = "ready";
      this.version = info.version;
      this.note =
        `opencode ${info.version ?? ""} detected — wrappers active. ` +
        `Uses your existing OpenCode provider config (no SkillOS key needed).`.trim();
    } else {
      this.status = "unavailable";
      this.version = null;
      this.note = INSTALL_HINT;
    }
    return this.status;
  }

  async run(
    commandName: string,
    input: string,
    sink: BridgeSink,
  ): Promise<BridgeRunResult> {
    const cmd = this.commands.find(
      (c) => c.name.toLowerCase() === commandName.toLowerCase(),
    );
    if (!cmd) {
      return {
        ok: false,
        code: null,
        error: `opencode bridge has no command "${commandName}"`,
      };
    }

    // Graceful degradation: if opencode isn't installed, demonstrate the wrapper
    // path without crashing — explain what WOULD run and how to enable it.
    if (this.status !== "ready") {
      sink.onInfo(
        `[opencode unavailable] Would proxy capability "${cmd.capabilityId}" with: "${input}"`,
      );
      sink.onInfo(INSTALL_HINT);
      return {
        ok: false,
        code: null,
        error: "opencode (OpenCode) is not installed (bridge unavailable)",
      };
    }

    const prompt = input.trim();
    if (!prompt) {
      return {
        ok: false,
        code: null,
        error: `Usage: /run ${cmd.name} <prompt>`,
      };
    }

    // OpenCode's non-interactive one-shot mode: `opencode run "<prompt>"`, built
    // as a SINGLE shell command string with the prompt safely quoted (see proc.ts
    // for why an argv array breaks under shell:true on Windows). stdin is closed
    // so the runner doesn't wait on it.
    const command = buildCommand(BIN, ["run"], prompt);
    sink.onInfo(
      `${BIN} run "${prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt}"`,
    );

    return spawnStream(command, sink, { endStdin: true });
  }
}
