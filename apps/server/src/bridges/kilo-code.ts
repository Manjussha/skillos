/**
 * Kilo Code bridge (Layer 5) — wrap the Kilo Code CLI as a SkillOS target.
 *
 * `/connect kilo-code` detects whether the Kilo Code binary is installed,
 * exposes a curated static capability map, and the registry generates wrappers
 * so a Kilo Code capability becomes runnable via `/run kilo-<id>`.
 *
 * BINARY UNCERTAINTY (honest): Kilo Code is primarily a VS Code / JetBrains
 * extension; its standalone CLI surface is less standardized than Claude Code /
 * Gemini / OpenCode. We best-guess the binary name by trying `kilocode` first,
 * then `kilo`, and proxy a non-interactive run with `<bin> run "<prompt>"`. If
 * neither binary exists, the bridge degrades gracefully (unavailable + hint).
 *
 * AUTH: like the other AI-CLI bridges, this proxies to the user's
 * LOCALLY-INSTALLED Kilo Code, which carries its OWN provider config/auth.
 * SkillOS does NOT need (and never reads) its own API key for this path.
 *
 * GRACEFUL DEGRADATION (hard requirement): if no Kilo Code binary is found,
 * detection never throws — we mark the bridge "unavailable" with an install
 * hint, STILL expose the static capability map (so wrappers are generated), and
 * make run() return ok:false (never throw). The mechanism stays demonstrable
 * offline. ALL spawning/parsing lives inside this module.
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

/**
 * Candidate binaries, tried in order. Kilo Code's CLI name isn't as established
 * as the other CLIs, so we probe the most likely names. The first one that
 * answers `--version` with exit 0 wins. shell:true so Windows npm shims resolve.
 */
const BIN_CANDIDATES = ["kilocode", "kilo"] as const;

/**
 * Curated static capability map for Kilo Code. No stable machine-readable
 * capability API, so we don't scrape `--help`; this tiny static map is the
 * isolated brittle bit. A non-interactive run can both answer questions and edit
 * files in the working dir, so we expose `ask` (read-only) and `edit`.
 */
const KILO_CAPABILITIES: BridgeCapability[] = [
  {
    id: "ask",
    description: "Ask Kilo Code a question about the codebase (prints the answer)",
    // Treated as read-only chat from SkillOS's perspective — no privileged tools.
    tools: [],
  },
  {
    id: "edit",
    description: "Have Kilo Code edit files in the working dir from an instruction",
    // A run that mutates the repo touches the filesystem and may run tools.
    tools: ["filesystem", "shell"],
  },
];

/** Map each capability to a user-facing wrapper command name. */
function deriveCommands(capabilities: BridgeCapability[]): BridgeCommand[] {
  return capabilities.map((cap) => ({
    name: `kilo-${cap.id}`,
    capabilityId: cap.id,
    description: `Kilo Code: ${cap.description}`,
  }));
}

const INSTALL_HINT = [
  "kilocode (Kilo Code) is not installed — the bridge is registered but unavailable.",
  "Kilo Code is primarily an IDE extension; a standalone CLI may not be present.",
  "Install Kilo Code: https://kilocode.ai",
  "If a CLI is available, expose it as `kilocode` (or `kilo`) on your PATH,",
  "then re-run /connect kilo-code.",
  "Uses your existing Kilo Code provider config/auth — no SkillOS API key needed.",
].join("\n");

export interface KiloInfo {
  installed: boolean;
  /** The binary that responded (so run() spawns the same one). */
  bin: string | null;
  version: string | null;
}

/**
 * Probe one candidate binary via `<bin> --version`. Never throws — resolves to
 * { ok:false } on any failure/timeout. Mirrors detectClaudeCode's shape.
 */
function probe(
  bin: string,
  timeoutMs: number,
): Promise<{ ok: boolean; version: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, version: string | null) => {
      if (settled) return;
      settled = true;
      resolve({ ok, version });
    };

    let child: ChildProcess;
    try {
      child = spawn(bin, ["--version"], { windowsHide: true, shell: true });
    } catch {
      done(false, null);
      return;
    }

    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => done(false, null));
    child.on("close", (code) => {
      if (code === 0) {
        const m = out.match(/(\d+\.\d+\.\d+\S*)/);
        done(true, m?.[1] ?? (out.trim() || "unknown"));
      } else {
        done(false, null);
      }
    });

    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done(false, null);
    }, timeoutMs);
  });
}

/**
 * Detect whether any Kilo Code binary is on PATH, trying each candidate in
 * order. Never throws — a missing binary resolves to { installed: false }.
 */
export async function detectKiloCode(timeoutMs = 12000): Promise<KiloInfo> {
  for (const bin of BIN_CANDIDATES) {
    const r = await probe(bin, timeoutMs);
    if (r.ok) return { installed: true, bin, version: r.version };
  }
  return { installed: false, bin: null, version: null };
}

export class KiloCodeBridge implements Bridge {
  readonly name = "kilo-code";
  readonly description =
    "Proxy SkillOS commands to the Kilo Code CLI (uses your Kilo Code provider config)";
  status: BridgeStatus = "unavailable";
  note: string | null = INSTALL_HINT;
  readonly capabilities: BridgeCapability[] = KILO_CAPABILITIES;
  readonly commands: BridgeCommand[] = deriveCommands(KILO_CAPABILITIES);

  private version: string | null = null;
  /** The detected binary name; defaults to the first candidate for messaging. */
  private bin: string = BIN_CANDIDATES[0];

  async connect(): Promise<BridgeStatus> {
    const info = await detectKiloCode();
    if (info.installed && info.bin) {
      this.status = "ready";
      this.version = info.version;
      this.bin = info.bin;
      this.note =
        `${info.bin} ${info.version ?? ""} detected — wrappers active. ` +
        `Uses your existing Kilo Code provider config (no SkillOS key needed).`.trim();
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
        error: `kilo-code bridge has no command "${commandName}"`,
      };
    }

    // Graceful degradation: if no Kilo Code binary is installed, demonstrate the
    // wrapper path without crashing — explain what WOULD run and how to enable it.
    if (this.status !== "ready") {
      sink.onInfo(
        `[kilo-code unavailable] Would proxy capability "${cmd.capabilityId}" with: "${input}"`,
      );
      sink.onInfo(INSTALL_HINT);
      return {
        ok: false,
        code: null,
        error: "kilocode (Kilo Code) is not installed (bridge unavailable)",
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

    // Best-guess non-interactive one-shot mode: `<bin> run "<prompt>"`, built as
    // a SINGLE shell command string with the prompt safely quoted (see proc.ts
    // for why an argv array breaks under shell:true on Windows). stdin is closed
    // so the runner doesn't wait on it.
    const command = buildCommand(this.bin, ["run"], prompt);
    sink.onInfo(
      `${this.bin} run "${prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt}"`,
    );

    return spawnStream(command, sink, { endStdin: true });
  }
}
