/**
 * Claude Code bridge (Layer 5) — wrap the Claude Code CLI as a SkillOS target.
 *
 * `/connect claude-code` detects whether the `claude` binary is installed,
 * exposes a curated static capability map, and the registry generates wrappers
 * so a Claude Code capability becomes runnable via `/run claude-<id>`.
 *
 * AUTH: this bridge proxies to the user's LOCALLY-INSTALLED Claude Code, which
 * carries its OWN auth/subscription (Claude.ai login or ANTHROPIC_API_KEY). It
 * therefore uses the user's existing Claude Code subscription — SkillOS does NOT
 * need (and never reads) its own API key for this path. We only spawn the CLI.
 *
 * NON-INTERACTIVE PROXY: Claude Code's headless/print mode is `claude -p
 * "<prompt>"`, which runs a single turn and prints the result to stdout instead
 * of opening the interactive TUI. We stream that stdout/stderr back live.
 *
 * GRACEFUL DEGRADATION (hard requirement): if `claude` is missing, detection
 * never throws — we mark the bridge "unavailable" with an install hint, STILL
 * expose the static capability map (so wrappers are generated), and make run()
 * return ok:false (never throw). The whole mechanism stays verifiable offline.
 *
 * Like every bridge, ALL spawning/parsing lives inside this module — the rest of
 * SkillOS only ever sees the `Bridge` interface.
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

/** Binary we detect/spawn. On Windows, npm global shims need shell:true. */
const BIN = "claude";

/**
 * Curated static capability map for Claude Code. Deliberately tiny + isolated —
 * Claude Code has no stable machine-readable capability API, so we don't scrape
 * `--help`; each entry becomes a generated wrapper command (see registry).
 */
const CLAUDE_CAPABILITIES: BridgeCapability[] = [
  {
    id: "ask",
    description: "Ask Claude Code a question (read-only, prints the answer)",
    // Read-only Q&A — no host mutation, so no privileged tools.
    tools: [],
  },
  {
    id: "edit",
    description: "Have Claude Code edit files in the working dir from an instruction",
    // Headless edit can write to disk and run tools — filesystem + shell.
    tools: ["filesystem", "shell"],
  },
];

/** Map each capability to a user-facing wrapper command name. */
function deriveCommands(capabilities: BridgeCapability[]): BridgeCommand[] {
  return capabilities.map((cap) => ({
    name: `claude-${cap.id}`,
    capabilityId: cap.id,
    description: `Claude Code: ${cap.description}`,
  }));
}

const INSTALL_HINT = [
  "claude (Claude Code) is not installed — the bridge is registered but unavailable.",
  "Install Claude Code: https://docs.claude.com/claude-code",
  "  npm i -g @anthropic-ai/claude-code",
  "Then sign in (claude) and re-run /connect claude-code.",
  "Uses your existing Claude Code auth/subscription — no SkillOS API key needed.",
].join("\n");

export interface ClaudeInfo {
  installed: boolean;
  version: string | null;
}

/**
 * Detect whether `claude` is on PATH via `claude --version`. Never throws — a
 * missing binary resolves to { installed: false }. Mirrors detectAider.
 */
export function detectClaudeCode(timeoutMs = 12000): Promise<ClaudeInfo> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (info: ClaudeInfo) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };

    let child: ChildProcess;
    try {
      // shell:true so Windows npm shims (claude.cmd / claude.ps1) resolve.
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
        // e.g. "2.1.150 (Claude Code)"
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

export class ClaudeCodeBridge implements Bridge {
  readonly name = "claude-code";
  readonly description =
    "Proxy SkillOS commands to the Claude Code CLI (uses your Claude subscription)";
  status: BridgeStatus = "unavailable";
  note: string | null = INSTALL_HINT;
  // Capabilities/commands exist regardless of whether claude is installed, so the
  // mechanism (and wrapper generation) is demonstrable offline.
  readonly capabilities: BridgeCapability[] = CLAUDE_CAPABILITIES;
  readonly commands: BridgeCommand[] = deriveCommands(CLAUDE_CAPABILITIES);

  private version: string | null = null;

  async connect(): Promise<BridgeStatus> {
    const info = await detectClaudeCode();
    if (info.installed) {
      this.status = "ready";
      this.version = info.version;
      this.note =
        `claude ${info.version ?? ""} detected — wrappers active. ` +
        `Uses your existing Claude Code auth/subscription (no SkillOS key needed).`.trim();
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
        error: `claude-code bridge has no command "${commandName}"`,
      };
    }

    // Graceful degradation: if claude isn't installed, demonstrate the wrapper
    // path without crashing — explain what WOULD run and how to enable it.
    if (this.status !== "ready") {
      sink.onInfo(
        `[claude-code unavailable] Would proxy capability "${cmd.capabilityId}" with: "${input}"`,
      );
      sink.onInfo(INSTALL_HINT);
      return {
        ok: false,
        code: null,
        error: "claude (Claude Code) is not installed (bridge unavailable)",
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

    // Claude Code's non-interactive print/headless mode: `claude -p "<prompt>"`,
    // built as a SINGLE shell command string with the prompt safely quoted (see
    // proc.ts for why an argv array breaks under shell:true on Windows). We close
    // stdin so Claude Code doesn't wait ~3s for piped input.
    const command = buildCommand(BIN, ["-p"], prompt);
    sink.onInfo(
      `${BIN} -p "${prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt}"`,
    );

    return spawnStream(command, sink, { endStdin: true });
  }
}
