/**
 * Command parser. Distinguishes free-text prompts from `/commands`.
 *
 *   "/seo write a title"  -> { kind: "command", name: "seo", args: "write a title" }
 *   "explain closures"    -> { kind: "prompt",  args: "explain closures" }
 */
export interface ParsedCommand {
  kind: "command" | "prompt";
  /** Present only when kind === "command": the word after the slash, lowercased. */
  name?: string;
  /** Everything after the command name (for prompts, the whole text). */
  args: string;
  raw: string;
}

export function parse(input: string): ParsedCommand {
  const raw = input.trim();
  if (!raw.startsWith("/")) {
    return { kind: "prompt", args: raw, raw };
  }
  const parts = raw.slice(1).split(/\s+/);
  const name = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1).join(" ");
  return { kind: "command", name, args, raw };
}
