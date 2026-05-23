/**
 * Local shell bridge (Layer 5) — the simplest reference implementation.
 *
 * Runs a shell command via Node's built-in `child_process` and streams stdout
 * and stderr back incrementally. This is the template every other bridge
 * follows: all spawning/parsing is isolated here, behind the `Bridge` interface.
 *
 * SECURITY: shell execution is privileged. The shell capability declares the
 * "shell" tool, so over a REMOTE session it goes through the existing Layer 4
 * permission gate (`ensurePermission` in index.ts) and requires explicit
 * per-invocation confirmation. LOCAL sessions stay permissive per the existing
 * trust model. There is no OS-level sandbox yet (Layer 4 flagged this) — the
 * permission gate is the active control. Treat enabling `shell` over remote as
 * granting remote code execution.
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

const SHELL_CAPABILITY: BridgeCapability = {
  id: "shell.exec",
  description: "Execute a shell command on the host and stream its output",
  tools: ["shell"],
};

const SHELL_COMMAND: BridgeCommand = {
  name: "shell",
  capabilityId: "shell.exec",
  description: "Run a shell command, e.g. /run shell echo hello",
};

/**
 * Choose the platform shell. We invoke through the shell so the user can use
 * pipes/builtins naturally — the same surface a terminal user already has.
 */
function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    // cmd.exe /d /s /c "<command>" — /s keeps quoting predictable.
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

export class ShellBridge implements Bridge {
  readonly name = "shell";
  readonly description = "Run shell commands on the host and stream output";
  status: BridgeStatus = "ready";
  note: string | null = null;
  readonly capabilities: BridgeCapability[] = [SHELL_CAPABILITY];
  readonly commands: BridgeCommand[] = [SHELL_COMMAND];

  /** A shell is always present, so connecting just confirms readiness. */
  async connect(): Promise<BridgeStatus> {
    this.status = "ready";
    this.note =
      "No OS sandbox yet — the Layer 4 permission gate is the active control. " +
      "Enabling shell over a remote session grants remote code execution.";
    return this.status;
  }

  async run(
    commandName: string,
    input: string,
    sink: BridgeSink,
  ): Promise<BridgeRunResult> {
    if (commandName.toLowerCase() !== "shell") {
      return { ok: false, code: null, error: `shell bridge has no command "${commandName}"` };
    }
    const command = input.trim();
    if (!command) {
      return { ok: false, code: null, error: "Usage: /run shell <command>" };
    }

    const { file, args } = shellInvocation(command);
    sink.onInfo(`$ ${command}`);

    return new Promise<BridgeRunResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(file, args, { windowsHide: true });
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

      // Stream both pipes incrementally as the process produces them.
      child.stdout?.on("data", (d: Buffer) =>
        sink.onChunk({ stream: "stdout", text: d.toString() }),
      );
      child.stderr?.on("data", (d: Buffer) =>
        sink.onChunk({ stream: "stderr", text: d.toString() }),
      );

      child.on("error", (err) => {
        finish({ ok: false, code: null, error: err.message });
      });
      child.on("close", (code) => {
        finish({ ok: code === 0, code: code ?? null });
      });
    });
  }
}
