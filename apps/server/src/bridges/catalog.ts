/**
 * AI-CLI catalog (Feature B) — a single extensible list of known AI coding/chat
 * CLIs SkillOS can detect and proxy.
 *
 * Instead of a fixed handful of bridges, SkillOS scans the system for ANY of the
 * CLIs described here and surfaces whichever are installed: they become
 * selectable in the unified `/provider` picker, connectable via `/connect <id>`,
 * runnable via `/run <id>-ask`, and usable as the active `cli` provider.
 *
 * Two kinds of catalog entries:
 *   - TUNED: a hand-written bridge module already exists (claude-code, gemini,
 *     opencode, kilo-code, aider). We reuse it verbatim for its richer behavior
 *     (version probe, stdin fallbacks, edit capability) — the catalog entry just
 *     carries detection metadata + the picker label.
 *   - GENERIC: no bespoke module. A single generic bridge (generic-cli.ts) drives
 *     it straight from the catalog entry: spawn via proc.ts, ask = `<bin>
 *     <askInvocation with the quoted prompt>`, graceful degrade when missing.
 *
 * DETECTION is a FAST PATH SCAN (see detect.ts): we look for each entry's
 * binCandidates in the PATH directories (with platform extensions on Windows) —
 * instant, and never spawns `<bin> --version` for the whole catalog at startup
 * (gemini cold-start alone is ~6s). The tuned bridges keep their own richer
 * detection for /connect.
 *
 * Adding a CLI = add one entry here. If it has a tuned module, set
 * `tuned: <bridge id>`; otherwise leave it generic and tune `askInvocation`.
 */

/** How the prompt is positioned in a generic CLI's argv. */
export type AskInvocation =
  /** `<bin> <flags...> "<prompt>"` — prompt as a trailing positional arg. */
  | { style: "positional"; flags: string[] }
  /** `<bin> <flag> "<prompt>"` — prompt as the value of a single flag. */
  | { style: "flag"; flag: string }
  /** `<bin> <flags...>` with the prompt piped on stdin (no prompt on argv). */
  | { style: "stdin"; flags: string[] };

export interface CliCatalogEntry {
  /** Stable id used everywhere (picker, /connect, SKILLOS_PROVIDER, cli pins). */
  id: string;
  /** Human label for the picker / messages. */
  label: string;
  /**
   * Binaries to look for on PATH, in priority order. The first one found wins
   * (and is what a generic bridge spawns). Platform extensions are added by the
   * detector, so list the bare names here (e.g. "codex", not "codex.cmd").
   */
  binCandidates: string[];
  /** How a generic bridge runs a read-only ask turn (ignored for tuned entries). */
  askInvocation: AskInvocation;
  /** How a generic bridge would run an edit turn, if it supports one (optional). */
  editInvocation?: AskInvocation;
  /** One-line install hint shown when the CLI isn't installed. */
  installHint: string;
  /**
   * Privileged tools the (generic) edit capability touches, for the Layer 4
   * permission gate. `ask` is always treated as read-only chat (no tools).
   */
  editTools?: string[];
  /**
   * If set, a hand-tuned bridge module owns this CLI (its registry id). The
   * catalog entry then only supplies detection metadata + label; the tuned
   * bridge's own richer run()/connect() is used.
   */
  tuned?: string;
}

/**
 * The catalog. Order is the picker order within the "Installed CLI tools" group.
 * The first five are TUNED (existing modules); the rest are GENERIC, driven from
 * these entries. Generic invocations are best-effort guesses based on each CLI's
 * documented non-interactive mode (honest gaps noted in the report).
 */
export const CLI_CATALOG: CliCatalogEntry[] = [
  // --- Tuned bridges (existing modules; reused verbatim) ---------------------
  {
    id: "claude-code",
    label: "Claude Code",
    binCandidates: ["claude"],
    askInvocation: { style: "flag", flag: "-p" },
    installHint: "npm i -g @anthropic-ai/claude-code",
    tuned: "claude-code",
  },
  {
    id: "gemini",
    label: "Gemini",
    binCandidates: ["gemini"],
    askInvocation: { style: "flag", flag: "-p" },
    installHint: "npm i -g @google/gemini-cli",
    tuned: "gemini",
  },
  {
    id: "opencode",
    label: "OpenCode",
    binCandidates: ["opencode"],
    askInvocation: { style: "positional", flags: ["run"] },
    installHint: "npm i -g opencode-ai",
    tuned: "opencode",
  },
  {
    id: "kilo-code",
    label: "Kilo Code",
    binCandidates: ["kilocode", "kilo"],
    askInvocation: { style: "positional", flags: ["run"] },
    installHint: "Kilo Code is primarily an IDE extension; see https://kilocode.ai",
    tuned: "kilo-code",
  },
  {
    id: "aider",
    label: "Aider",
    binCandidates: ["aider"],
    askInvocation: { style: "flag", flag: "--message" },
    installHint: "pipx install aider-chat",
    tuned: "aider",
  },

  // --- Generic (catalog-driven) bridges -------------------------------------
  {
    id: "codex",
    label: "Codex (OpenAI Codex CLI)",
    binCandidates: ["codex"],
    // Codex CLI non-interactive: `codex exec "<prompt>"` prints the answer.
    askInvocation: { style: "positional", flags: ["exec"] },
    editInvocation: { style: "positional", flags: ["exec"] },
    editTools: ["filesystem", "shell"],
    installHint: "npm i -g @openai/codex",
  },
  {
    id: "cursor-agent",
    label: "Cursor Agent (Cursor CLI)",
    binCandidates: ["cursor-agent"],
    // Cursor's headless agent: `cursor-agent -p "<prompt>"` (print mode).
    askInvocation: { style: "flag", flag: "-p" },
    installHint: "curl https://cursor.com/install -fsS | bash",
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    binCandidates: ["copilot"],
    // Copilot CLI programmatic mode: `copilot -p "<prompt>"`.
    askInvocation: { style: "flag", flag: "-p" },
    installHint: "npm i -g @github/copilot",
  },
  {
    id: "sgpt",
    label: "Shell-GPT (sgpt)",
    binCandidates: ["sgpt"],
    // sgpt takes the prompt as a positional arg: `sgpt "<prompt>"`.
    askInvocation: { style: "positional", flags: [] },
    installHint: "pipx install shell-gpt",
  },
  {
    id: "llm",
    label: "llm (Simon Willison's CLI)",
    binCandidates: ["llm"],
    // `llm "<prompt>"` runs a one-shot prompt against the default model.
    askInvocation: { style: "positional", flags: [] },
    installHint: "pipx install llm",
  },
  {
    id: "goose",
    label: "Goose (Block)",
    binCandidates: ["goose"],
    // Goose one-shot: `goose run -t "<prompt>"` (text instruction).
    askInvocation: { style: "flag", flag: "-t" },
    editTools: ["filesystem", "shell"],
    installHint: "see https://block.github.io/goose/",
  },
  {
    id: "crush",
    label: "Crush (Charm)",
    binCandidates: ["crush"],
    // Crush non-interactive: `crush run "<prompt>"`.
    askInvocation: { style: "positional", flags: ["run"] },
    editTools: ["filesystem", "shell"],
    installHint: "npm i -g @charmland/crush",
  },
  {
    id: "qwen",
    label: "Qwen Code",
    binCandidates: ["qwen"],
    // Qwen Code is a Gemini-CLI fork: `qwen -p "<prompt>"`.
    askInvocation: { style: "flag", flag: "-p" },
    installHint: "npm i -g @qwen-code/qwen-code",
  },
];

/** Look up a catalog entry by id. */
export function catalogEntry(id: string): CliCatalogEntry | undefined {
  return CLI_CATALOG.find((e) => e.id === id);
}

/** All catalog ids, in catalog order. */
export function catalogIds(): string[] {
  return CLI_CATALOG.map((e) => e.id);
}
