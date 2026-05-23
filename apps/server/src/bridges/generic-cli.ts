/**
 * Generic catalog-driven bridge (Feature B).
 *
 * For catalog CLIs that DON'T have a hand-tuned module (codex, cursor-agent,
 * copilot, sgpt, llm, goose, crush, qwen, …) this single class implements the
 * `Bridge` interface entirely from a `CliCatalogEntry`. It detects the binary by
 * the fast PATH scan (no `--version` spawn), then proxies a non-interactive
 * "ask" turn by spawning `<bin> <askInvocation> "<prompt>"` through proc.ts
 * (which handles Windows shim quoting). An optional `edit` capability is exposed
 * when the entry declares `editInvocation`.
 *
 * Like every bridge: ALL spawning/parsing is contained here, detection never
 * throws, and an uninstalled CLI degrades gracefully (status "unavailable" +
 * install hint, run() returns ok:false). The non-interactive invocations are
 * best-effort guesses from each CLI's documented headless mode — honest, and
 * isolated to the catalog entry so they're trivial to correct.
 */

import type {
  Bridge,
  BridgeCapability,
  BridgeCommand,
  BridgeRunResult,
  BridgeSink,
  BridgeStatus,
} from "./types.js";
import type { AskInvocation, CliCatalogEntry } from "./catalog.js";
import { firstBinaryOnPath } from "./detect.js";
import { buildCommand, spawnStream } from "./proc.js";

export class GenericCliBridge implements Bridge {
  readonly name: string;
  readonly description: string;
  status: BridgeStatus = "unavailable";
  note: string | null;
  readonly capabilities: BridgeCapability[];
  readonly commands: BridgeCommand[];

  private readonly entry: CliCatalogEntry;
  /** The PATH-resolved binary name to spawn (set on connect). */
  private bin: string;

  constructor(entry: CliCatalogEntry) {
    this.entry = entry;
    this.name = entry.id;
    this.description = `Proxy SkillOS commands to the ${entry.label} CLI (uses its own auth/config)`;
    this.bin = entry.binCandidates[0] ?? entry.id;
    this.note = this.installHint();

    this.capabilities = [
      {
        id: "ask",
        description: `Ask ${entry.label} a question / give it a prompt (prints the answer)`,
        tools: [],
      },
    ];
    if (entry.editInvocation) {
      this.capabilities.push({
        id: "edit",
        description: `Have ${entry.label} edit files in the working dir from an instruction`,
        tools: entry.editTools ?? ["filesystem", "shell"],
      });
    }
    this.commands = this.capabilities.map((cap) => ({
      name: `${entry.id}-${cap.id}`,
      capabilityId: cap.id,
      description: `${entry.label}: ${cap.description}`,
    }));
  }

  private installHint(): string {
    return [
      `${this.entry.label} is not installed — the bridge is registered but unavailable.`,
      `Install it: ${this.entry.installHint}`,
      `Then re-run /connect ${this.entry.id}. Uses the CLI's own auth — no SkillOS key needed.`,
    ].join("\n");
  }

  /**
   * Detect by FAST PATH SCAN (no `--version` spawn). Sets status + the resolved
   * binary name. Never throws.
   */
  async connect(): Promise<BridgeStatus> {
    const found = firstBinaryOnPath(this.entry.binCandidates);
    if (found) {
      this.bin = found;
      this.status = "ready";
      this.note =
        `${this.entry.label} detected on PATH (${found}) — wrappers active. ` +
        `Uses the CLI's own auth/config (no SkillOS key needed).`;
    } else {
      this.status = "unavailable";
      this.note = this.installHint();
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
        error: `${this.entry.id} bridge has no command "${commandName}"`,
      };
    }

    if (this.status !== "ready") {
      sink.onInfo(
        `[${this.entry.id} unavailable] Would proxy capability "${cmd.capabilityId}" with: "${input}"`,
      );
      sink.onInfo(this.installHint());
      return {
        ok: false,
        code: null,
        error: `${this.entry.label} is not installed (bridge unavailable)`,
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

    const invocation =
      cmd.capabilityId === "edit" && this.entry.editInvocation
        ? this.entry.editInvocation
        : this.entry.askInvocation;

    return this.spawnInvocation(invocation, prompt, sink);
  }

  /** Build + spawn the configured invocation, streaming output. */
  private spawnInvocation(
    inv: AskInvocation,
    prompt: string,
    sink: BridgeSink,
  ): Promise<BridgeRunResult> {
    const preview = prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt;

    if (inv.style === "stdin") {
      // Prompt piped on stdin — never touches the shell command line.
      const command = buildCommand(this.bin, inv.flags, "");
      sink.onInfo(`${this.bin} ${inv.flags.join(" ")} (prompt on stdin)`);
      return spawnStream(
        command,
        sink,
        { stdin: prompt },
        ({ code, sawStdout, stderr }) => ({
          ok: code === 0 && sawStdout,
          code: code ?? null,
          error:
            code === 0 && sawStdout
              ? undefined
              : stderr.trim() || `${this.entry.id} produced no output`,
        }),
      );
    }

    const fixed = inv.style === "flag" ? [inv.flag] : inv.flags;
    const command = buildCommand(this.bin, fixed, prompt);
    sink.onInfo(`${this.bin} ${fixed.join(" ")} "${preview}"`);
    return spawnStream(
      command,
      sink,
      { endStdin: true },
      ({ code, sawStdout, stderr }) => ({
        ok: code === 0 && sawStdout,
        code: code ?? null,
        error:
          code === 0 && sawStdout
            ? undefined
            : stderr.trim() || `${this.entry.id} produced no usable output`,
      }),
    );
  }
}
