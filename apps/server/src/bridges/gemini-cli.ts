/**
 * Gemini CLI bridge (Layer 5) — wrap Google's Gemini CLI as a SkillOS target.
 *
 * `/connect gemini` detects whether the `gemini` binary is installed, exposes a
 * curated capability map, and the registry generates wrappers so a Gemini CLI
 * capability becomes runnable via `/run gemini-<id>`.
 *
 * AUTH: this bridge proxies to the user's LOCALLY-INSTALLED Gemini CLI, which
 * carries its OWN auth (a Google login or GEMINI_API_KEY in its environment). It
 * uses the user's existing Gemini CLI auth — SkillOS does NOT need (and never
 * reads) its own API key for this path. We only spawn the CLI.
 *
 * NON-INTERACTIVE PROXY: Gemini CLI runs a single non-interactive turn with
 * `gemini -p "<prompt>"` (its prompt flag), printing the model's answer to
 * stdout instead of opening the interactive TUI. We stream that back live. If
 * `-p` ever misbehaves, we fall back to piping the prompt on stdin (`gemini`
 * reads a prompt from stdin in non-TTY contexts) — both paths are inside this
 * module so the brittleness stays contained.
 *
 * GRACEFUL DEGRADATION (hard requirement): if `gemini` is missing, detection
 * never throws — we mark the bridge "unavailable" with an install hint, STILL
 * expose the static capability map (so wrappers are generated), and make run()
 * return ok:false (never throw). The whole mechanism stays verifiable offline.
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
const BIN = "gemini";

/**
 * Curated static capability map for the Gemini CLI. Gemini exposes no stable
 * machine-readable capability API, so we don't scrape `--help`; this tiny static
 * map is the isolated brittle bit. Gemini CLI's non-interactive `-p` mode is a
 * read-only chat turn from SkillOS's perspective, so we expose `ask`.
 */
const GEMINI_CAPABILITIES: BridgeCapability[] = [
  {
    id: "ask",
    description: "Ask Gemini a question / give it a prompt (prints the answer)",
    // Non-interactive prompt = read-only chat — no host mutation, no tools.
    tools: [],
  },
];

/** Map each capability to a user-facing wrapper command name. */
function deriveCommands(capabilities: BridgeCapability[]): BridgeCommand[] {
  return capabilities.map((cap) => ({
    name: `gemini-${cap.id}`,
    capabilityId: cap.id,
    description: `Gemini CLI: ${cap.description}`,
  }));
}

const INSTALL_HINT = [
  "gemini (Gemini CLI) is not installed — the bridge is registered but unavailable.",
  "Install Gemini CLI: https://github.com/google-gemini/gemini-cli",
  "  npm i -g @google/gemini-cli",
  "Then authenticate (Google login or set GEMINI_API_KEY) and re-run /connect gemini.",
  "Uses your existing Gemini CLI auth — no SkillOS API key needed.",
].join("\n");

export interface GeminiInfo {
  installed: boolean;
  version: string | null;
}

/**
 * Detect whether `gemini` is on PATH via `gemini --version`. Never throws — a
 * missing binary resolves to { installed: false }. Mirrors detectAider.
 */
// Gemini CLI is a heavy Node program — `gemini --version` can take ~6s to cold
// start here, so the detection timeout is generous to avoid a false "missing".
export function detectGemini(timeoutMs = 12000): Promise<GeminiInfo> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (info: GeminiInfo) => {
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
        // e.g. "0.33.0"
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

export class GeminiCliBridge implements Bridge {
  readonly name = "gemini";
  readonly description =
    "Proxy SkillOS commands to Google's Gemini CLI (uses your Gemini CLI auth)";
  status: BridgeStatus = "unavailable";
  note: string | null = INSTALL_HINT;
  readonly capabilities: BridgeCapability[] = GEMINI_CAPABILITIES;
  readonly commands: BridgeCommand[] = deriveCommands(GEMINI_CAPABILITIES);

  private version: string | null = null;

  async connect(): Promise<BridgeStatus> {
    const info = await detectGemini();
    if (info.installed) {
      this.status = "ready";
      this.version = info.version;
      this.note =
        `gemini ${info.version ?? ""} detected — wrappers active. ` +
        `Uses your existing Gemini CLI auth (no SkillOS key needed).`.trim();
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
        error: `gemini bridge has no command "${commandName}"`,
      };
    }

    // Graceful degradation: if gemini isn't installed, demonstrate the wrapper
    // path without crashing — explain what WOULD run and how to enable it.
    if (this.status !== "ready") {
      sink.onInfo(
        `[gemini unavailable] Would proxy capability "${cmd.capabilityId}" with: "${input}"`,
      );
      sink.onInfo(INSTALL_HINT);
      return {
        ok: false,
        code: null,
        error: "gemini (Gemini CLI) is not installed (bridge unavailable)",
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

    // Primary path: Gemini CLI's non-interactive prompt flag, built as a SINGLE
    // shell command string with the prompt safely quoted (see proc.ts for why an
    // argv array breaks under shell:true on Windows). stdin is closed so the CLI
    // doesn't wait on it.
    const command = buildCommand(BIN, ["-p"], prompt);
    sink.onInfo(
      `${BIN} -p "${prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt}"`,
    );

    const primary = await spawnStream(
      command,
      sink,
      { endStdin: true },
      ({ code, sawStdout, stderr }) => ({
        ok: code === 0 && sawStdout,
        code: code ?? null,
        error:
          code === 0 && sawStdout
            ? undefined
            : stderr.trim() || "gemini -p produced no output",
      }),
    );
    if (primary.ok) return primary;

    // Fallback: pipe the prompt on stdin (Gemini reads a headless prompt from
    // stdin in non-TTY mode). This is also injection-proof — the user's text
    // never touches the shell command line. Contained here like the rest.
    sink.onInfo("(gemini -p produced no usable output; retrying via stdin)");
    const fallback = await spawnStream(
      BIN,
      sink,
      { stdin: prompt },
      ({ code, sawStdout, stderr }) => ({
        ok: code === 0 && sawStdout,
        code: code ?? null,
        error:
          code === 0 && sawStdout
            ? undefined
            : stderr.trim() || primary.error || "gemini produced no output",
      }),
    );
    return fallback;
  }
}
