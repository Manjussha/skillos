/**
 * Fast binary detection by PATH scan (Feature B).
 *
 * Why not `<bin> --version`? Spawning every catalog CLI's `--version` at startup
 * is far too slow — gemini's cold start alone is ~6s, and the catalog has a dozen
 * entries. A PATH scan is effectively instant: we read the PATH directories ONCE,
 * list their contents, and check each candidate name (with the platform's
 * executable extensions on Windows) against that set. No child processes.
 *
 * This gives the unified picker an installed/not-installed answer per catalog
 * entry without paying any cold-start cost. The tuned bridges still run their own
 * richer `--version` probe when actually connected (/connect, or selected as the
 * active provider) so their version note + edit behavior is unchanged.
 */

import { readdirSync } from "node:fs";
import { delimiter } from "node:path";

const isWindows = process.platform === "win32";

/**
 * Executable extensions to try on Windows (npm shims are .cmd/.ps1; native is
 * .exe; .bat for some installers). We also accept the bare name (some tools ship
 * extensionless). On POSIX only the bare name matters.
 */
const WIN_EXEC_EXTS = [".exe", ".cmd", ".bat", ".ps1", ".com", ""];

/** Lowercased set of every filename found across all PATH directories. */
let pathFilesCache: Set<string> | null = null;

/** Build (once) the lowercased set of all filenames on PATH. Never throws. */
function pathFiles(): Set<string> {
  if (pathFilesCache) return pathFilesCache;
  const set = new Set<string>();
  const raw = process.env.PATH ?? process.env.Path ?? "";
  const dirs = raw.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      for (const name of readdirSync(dir)) {
        set.add(name.toLowerCase());
      }
    } catch {
      // Unreadable / missing PATH dir — skip it.
    }
  }
  // Also include the npm global prefix's bin, which is on PATH already on most
  // setups but cheap to be safe about; ignored if it duplicates.
  pathFilesCache = set;
  return set;
}

/** Reset the cached PATH listing (used by tests / a manual rescan). */
export function resetPathScanCache(): void {
  pathFilesCache = null;
}

/**
 * True if any of the candidate binary names is found on PATH. Matches the bare
 * name and, on Windows, the name + each executable extension.
 */
export function isBinaryOnPath(candidates: readonly string[]): boolean {
  const files = pathFiles();
  for (const cand of candidates) {
    const base = cand.toLowerCase();
    if (files.has(base)) return true;
    if (isWindows) {
      for (const ext of WIN_EXEC_EXTS) {
        if (ext && files.has(base + ext)) return true;
      }
    }
  }
  return false;
}

/** The first candidate name actually present on PATH, or null. */
export function firstBinaryOnPath(
  candidates: readonly string[],
): string | null {
  const files = pathFiles();
  for (const cand of candidates) {
    const base = cand.toLowerCase();
    if (files.has(base)) return cand;
    if (isWindows) {
      for (const ext of WIN_EXEC_EXTS) {
        if (ext && files.has(base + ext)) return cand;
      }
    }
  }
  return null;
}
