/**
 * Shared process helpers for the external AI-CLI bridges (Layer 5).
 *
 * Why this exists: on Windows + Node 22, spawning an npm-installed CLI is fiddly.
 *   1. The CLI is a `.cmd`/`.ps1` shim, and Node 22 refuses to spawn those
 *      without `shell: true` (EINVAL — CVE-2024-27980 mitigation). So we MUST go
 *      through the shell.
 *   2. With `shell: true`, passing an argv ARRAY makes Node re-join the args into
 *      a command string WITHOUT quoting, so a multi-word prompt arg gets split
 *      into multiple shell tokens (this is what made `gemini -p <prompt>` fail
 *      with "Cannot use both a positional prompt and the --prompt flag"). The fix
 *      is to build ONE command string ourselves and quote the user's prompt.
 *
 * `shellQuoteArg` does that quoting. It is the only place user text touches the
 * shell command line, so the (small) injection surface is isolated here. The
 * bridges that prefer it also offer a stdin path (no user text on the command
 * line at all), which is the injection-proof fallback.
 *
 * Cross-platform: on non-Windows we still use `shell: true` for consistency and
 * quote with single quotes (POSIX-safe). On Windows we quote for cmd.exe.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { BridgeRunResult, BridgeSink } from "./types.js";

const isWindows = process.platform === "win32";

/**
 * Quote a single argument so it survives as ONE token through the platform shell.
 * - Windows (cmd.exe): wrap in double quotes; escape embedded double quotes by
 *   doubling them and neutralize the shell metacharacters cmd would otherwise
 *   interpret. We strip CR/LF (a prompt is one line on the command line; use the
 *   stdin path for multi-line input).
 * - POSIX: wrap in single quotes; close/reopen to embed a literal single quote.
 */
export function shellQuoteArg(arg: string): string {
  if (isWindows) {
    const cleaned = arg.replace(/[\r\n]+/g, " ");
    // Double embedded quotes (cmd's escaping), then wrap. The surrounding quotes
    // mean cmd treats &, |, <, >, ^ inside as literal text, not operators.
    return `"${cleaned.replace(/"/g, '""')}"`;
  }
  // POSIX single-quote: 'it'\''s' style.
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Build a single shell command line from a binary + already-fixed flags + a
 * user-supplied argument that gets safely quoted. */
export function buildCommand(
  bin: string,
  fixedArgs: string[],
  userArg: string,
): string {
  const parts = [bin, ...fixedArgs];
  if (userArg.length > 0) parts.push(shellQuoteArg(userArg));
  return parts.join(" ");
}

export interface SpawnStreamOptions {
  /** Text to write to the child's stdin, then close it (optional). */
  stdin?: string;
  /** If no stdin text is given, end stdin immediately so CLIs that wait on it
   * (e.g. Claude Code warns after 3s) don't stall. Defaults to true. */
  endStdin?: boolean;
}

/**
 * Spawn a command string through the platform shell and stream stdout/stderr to
 * the sink. Resolves a BridgeRunResult on close — NEVER throws (a spawn failure
 * resolves ok:false). `onClose` lets the caller decide ok/fallback from the code
 * and whether any stdout was seen.
 */
export function spawnStream(
  command: string,
  sink: BridgeSink,
  opts: SpawnStreamOptions = {},
  onClose?: (ctx: {
    code: number | null;
    sawStdout: boolean;
    stderr: string;
  }) => BridgeRunResult,
): Promise<BridgeRunResult> {
  return new Promise<BridgeRunResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, { windowsHide: true, shell: true });
    } catch (err) {
      resolve({ ok: false, code: null, error: (err as Error).message });
      return;
    }

    let settled = false;
    let sawStdout = false;
    let stderr = "";
    const finish = (res: BridgeRunResult) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };

    child.stdout?.on("data", (d: Buffer) => {
      sawStdout = true;
      sink.onChunk({ stream: "stdout", text: d.toString() });
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      sink.onChunk({ stream: "stderr", text });
    });
    child.on("error", (err) =>
      finish({ ok: false, code: null, error: err.message }),
    );
    child.on("close", (code) => {
      if (onClose) finish(onClose({ code, sawStdout, stderr }));
      else finish({ ok: code === 0, code: code ?? null });
    });

    // Feed/close stdin. CLIs that block waiting for piped input stall otherwise.
    try {
      if (opts.stdin !== undefined) {
        child.stdin?.write(opts.stdin.endsWith("\n") ? opts.stdin : opts.stdin + "\n");
        child.stdin?.end();
      } else if (opts.endStdin !== false) {
        child.stdin?.end();
      }
    } catch {
      /* ignore — the close handler reports the outcome */
    }
  });
}
