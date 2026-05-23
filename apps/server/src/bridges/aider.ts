/**
 * Aider bridge (Layer 5) — the first AI-terminal target.
 *
 * `/connect aider` detects whether `aider` is installed, derives its
 * capabilities + commands, and the registry generates internal skill wrappers so
 * an Aider capability becomes runnable from SkillOS via `/run <wrapped>`.
 *
 * GRACEFUL DEGRADATION (hard requirement): `aider` is almost certainly NOT
 * installed in this environment. Detection must never crash — when aider is
 * missing we report how to install it, mark the bridge "unavailable", and STILL
 * expose a known static capability map (and therefore generate the wrappers), so
 * the whole bridge mechanism is verifiable offline. Running a wrapper while
 * unavailable returns a clear ok:false (with the install hint), never a throw.
 *
 * Reality check (ROADMAP.md): aider has no stable machine-readable capability
 * API. We do not scrape `aider --help` for behavior; we use a curated static
 * capability map (the brittle part — kept tiny and isolated here). If aider IS
 * present we additionally confirm its version. When we eventually proxy, we use
 * aider's non-interactive one-shot mode (`--message`) and stream its stdout.
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

/**
 * Curated static capability map for Aider. This is the deliberately-isolated
 * brittle bit: it encodes what we know Aider can do, independent of any runtime
 * probe. Each capability becomes a generated wrapper command (see registry).
 */
const AIDER_CAPABILITIES: BridgeCapability[] = [
  {
    id: "edit",
    description: "Edit files in a repo from a natural-language instruction",
    // Aider writes to disk and may run git — filesystem + shell.
    tools: ["filesystem", "shell"],
  },
  {
    id: "ask",
    description: "Ask a question about the codebase (read-only, no edits)",
    tools: ["filesystem"],
  },
  {
    id: "commit",
    description: "Stage and commit Aider's changes with a generated message",
    tools: ["filesystem", "shell"],
  },
];

/** Map each capability to a user-facing wrapper command name. */
function deriveCommands(capabilities: BridgeCapability[]): BridgeCommand[] {
  return capabilities.map((cap) => ({
    name: `aider-${cap.id}`,
    capabilityId: cap.id,
    description: `Aider: ${cap.description}`,
  }));
}

const INSTALL_HINT = [
  "aider is not installed — the bridge is registered but unavailable.",
  "Install it to enable real proxying:",
  "  pipx install aider-chat   (recommended)",
  "  pip install aider-chat",
  "Then re-run /connect aider.",
].join("\n");

export interface AiderInfo {
  installed: boolean;
  version: string | null;
}

/**
 * Detect whether `aider` is on PATH via `aider --version`. Never throws — a
 * missing binary resolves to { installed: false }. Mirrors detectCloudflared.
 */
export function detectAider(timeoutMs = 4000): Promise<AiderInfo> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (info: AiderInfo) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };

    let child: ChildProcess;
    try {
      child = spawn("aider", ["--version"], { windowsHide: true });
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
        const m = out.match(/aider\s+(\S+)/i);
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

export class AiderBridge implements Bridge {
  readonly name = "aider";
  readonly description = "Proxy SkillOS commands to the Aider AI coding terminal";
  status: BridgeStatus = "unavailable";
  note: string | null = INSTALL_HINT;
  // Capabilities/commands exist regardless of whether aider is installed, so the
  // mechanism (and wrapper generation) is demonstrable offline.
  readonly capabilities: BridgeCapability[] = AIDER_CAPABILITIES;
  readonly commands: BridgeCommand[] = deriveCommands(AIDER_CAPABILITIES);

  private version: string | null = null;

  async connect(): Promise<BridgeStatus> {
    const info = await detectAider();
    if (info.installed) {
      this.status = "ready";
      this.version = info.version;
      this.note = `aider ${info.version ?? ""} detected — wrappers active.`.trim();
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
        error: `aider bridge has no command "${commandName}"`,
      };
    }

    // Graceful degradation: if aider isn't installed, demonstrate the wrapper
    // path without crashing — explain what WOULD run and how to enable it.
    if (this.status !== "ready") {
      sink.onInfo(
        `[aider unavailable] Would proxy capability "${cmd.capabilityId}" with: "${input}"`,
      );
      sink.onInfo(INSTALL_HINT);
      return {
        ok: false,
        code: null,
        error: "aider is not installed (bridge unavailable)",
      };
    }

    const message = input.trim();
    if (!message) {
      return {
        ok: false,
        code: null,
        error: `Usage: /run ${cmd.name} <instruction>`,
      };
    }

    // Aider's non-interactive one-shot mode. Read-only "ask" capabilities map to
    // a question; editing/commit map to a message that mutates the repo.
    const args =
      cmd.capabilityId === "ask"
        ? ["--no-auto-commits", "--yes", "--message", `/ask ${message}`]
        : ["--yes", "--message", message];

    sink.onInfo(`aider ${args.join(" ")}`);

    return new Promise<BridgeRunResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn("aider", args, { windowsHide: true });
      } catch (err) {
        resolve({ ok: false, code: null, error: (err as Error).message });
        return;
      }
      let settled = false;
      const finish = (res: BridgeRunResult) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };
      child.stdout?.on("data", (d: Buffer) =>
        sink.onChunk({ stream: "stdout", text: d.toString() }),
      );
      child.stderr?.on("data", (d: Buffer) =>
        sink.onChunk({ stream: "stderr", text: d.toString() }),
      );
      child.on("error", (err) => finish({ ok: false, code: null, error: err.message }));
      child.on("close", (code) => finish({ ok: code === 0, code: code ?? null }));
    });
  }
}
