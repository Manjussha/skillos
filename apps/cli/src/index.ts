import readline from "node:readline";
import { WebSocket } from "ws";

/**
 * SkillOS native terminal client.
 *
 * A thin CLI over the same WebSocket protocol the browser terminal uses, so you
 * can drive SkillOS directly from your shell. It renders EVERY server message
 * type (info / chunk / error / done / stage / qr / permission-request) and sends
 * every client message (input / auth / permission-response).
 *
 * On a real terminal (TTY) it shows a live, navigable slash-command menu: type
 * "/", filter as you go, ↑/↓ to move, Tab to fill, Enter to run, Esc to dismiss.
 * When piped / non-interactive it falls back to plain line input.
 *
 * Usage:
 *   npm run cli                       # connect to ws://localhost:8787
 *   npm run cli -- --url ws://host    # custom server
 *   npm run cli -- --token <token>    # authenticate a remote session
 */

// ---- Protocol (mirrors apps/server/src/types.ts) --------------------------
type ServerMessage =
  | { type: "info"; text: string }
  | { type: "chunk"; text: string }
  | { type: "error"; text: string }
  | { type: "done"; meta: { skill: string | null; model: string; provider: string } }
  | { type: "stage"; agent: string; step: number; total: number; model: string; provider: string }
  | { type: "qr"; art: string; url: string }
  | { type: "permission-request"; id: string; target: string; scopes: string[]; text: string };

// ---- Args / config --------------------------------------------------------
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const URL = arg("--url") ?? process.env.SKILLOS_URL ?? "ws://localhost:8787";
const TOKEN = arg("--token") ?? process.env.SKILLOS_TOKEN;

// ---- ANSI -----------------------------------------------------------------
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[1;32m",
  cyan: "\x1b[1;36m",
  yellow: "\x1b[33m",
};
const PROMPT = `${C.green}skillos>${C.reset} `;
const PROMPT_LEN = "skillos> ".length; // visible width (no ANSI)

/** Slash commands offered in the autocomplete menu (client-side mirror). */
const COMMANDS: [string, string][] = [
  ["/help", "list all commands"],
  ["/skills", "list your skills"],
  ["/models", "pick a model"],
  ["/provider", "switch provider / connect a key"],
  ["/use", "force a model: /use <model>"],
  ["/onboarding", "re-run setup"],
  ["/profile", "show your saved profile"],
  ["/generate-skills", "generate skills for a domain"],
  ["/agents", "list agents & workflows"],
  ["/agent", "run one agent: /agent <name> <task>"],
  ["/build-dashboard", "workflow: plan → code → review"],
  ["/build-api", "workflow: plan → code → review"],
  ["/remote", "remote access: /remote start|status|stop"],
  ["/connect", "connect a bridge: /connect shell|aider"],
  ["/bridges", "list connected bridges"],
  ["/run", "run a skill or bridge command"],
  ["/exit", "quit the CLI"],
];

// ---- Shared turn state ----------------------------------------------------
let busy = false; // a turn is in flight; suppress input + the prompt
let pendingNewline = false; // a banner printed; break before streamed chunks
let pendingPermission: string | null = null; // id of an awaiting permission prompt
let stdinClosed = false;

const out = (s: string): void => void process.stdout.write(s);

// ---- Connection -----------------------------------------------------------
out(`${C.green}SkillOS${C.reset} ${C.dim}— connecting to ${URL}…${C.reset}\n`);
const ws = new WebSocket(URL);

ws.on("open", () => {
  if (TOKEN) ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
});

ws.on("message", (raw: Buffer) => {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(raw.toString()) as ServerMessage;
  } catch {
    return;
  }
  switch (msg.type) {
    case "info":
      ui.message(msg.text, C.dim);
      pendingNewline = true;
      break;
    case "stage":
      ui.message(`■ ${msg.agent} [${msg.step}/${msg.total}] (${msg.model})`, C.cyan);
      pendingNewline = true;
      break;
    case "qr":
      ui.message(msg.art, C.cyan);
      ui.message(`Access URL: ${msg.url}`, C.green);
      pendingNewline = true;
      break;
    case "chunk":
      if (pendingNewline) {
        out("\n");
        pendingNewline = false;
      }
      out(msg.text);
      break;
    case "error":
      ui.message(msg.text, C.red);
      endTurn();
      break;
    case "done":
      if (msg.meta.model) ui.message(`[${msg.meta.model} via ${msg.meta.provider}]`, C.dim);
      endTurn();
      break;
    case "permission-request":
      ui.message(msg.text, C.cyan);
      ui.message(`Approve ${msg.target} (${msg.scopes.join(", ")})? [y/N]`, C.yellow);
      pendingPermission = msg.id;
      busy = false;
      ui.rearm();
      break;
  }
});

ws.on("close", () => {
  ui.message("Disconnected from server.", C.red);
  ui.stop();
  process.exit(0);
});
ws.on("error", (err: Error) => {
  ui.message(`Connection error: ${err.message}`, C.red);
  ui.message(`Is the server running?  npm run dev:server`, C.dim);
  ui.stop();
  process.exit(1);
});

// ---- Submit / turn lifecycle (shared) -------------------------------------
function submit(text: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const t = text.trim();

  if (pendingPermission) {
    const approved = /^y(es)?$/i.test(t);
    ws.send(JSON.stringify({ type: "permission-response", id: pendingPermission, approved }));
    pendingPermission = null;
    busy = true;
    ui.beginTurn();
    return;
  }
  if (busy) return;
  if (!t) {
    ui.rearm();
    return;
  }
  if (t === "/exit" || t === "/quit") {
    ui.stop();
    ws.close();
    process.exit(0);
  }
  busy = true;
  pendingNewline = false;
  ui.beginTurn();
  ws.send(JSON.stringify({ type: "input", text: t }));
}

function endTurn(): void {
  busy = false;
  pendingNewline = false;
  pendingPermission = null;
  if (stdinClosed) {
    ui.stop();
    ws.close();
    process.exit(0);
  }
  ui.rearm();
}

// ---- UI abstraction -------------------------------------------------------
interface UI {
  message(text: string, color?: string): void; // print a discrete server message
  rearm(): void; // turn ended / idle — show a fresh prompt
  beginTurn(): void; // user submitted — clear the input region for output
  stop(): void;
}

const isTTY = Boolean(process.stdin.isTTY);
const ui: UI = isTTY ? createInteractiveUI() : createLineUI();

// ---- Interactive UI (raw mode + slash-command menu) -----------------------
function createInteractiveUI(): UI {
  let line = ""; // current input (cursor is always at end)
  let menuOpen = false;
  let items: [string, string][] = [];
  let sel = 0;
  let promptShown = false;

  const refreshMenu = (): void => {
    const m = /^\/(\S*)$/.exec(line); // "/", "/sk" … but not after a space
    if (m) {
      const p = (m[1] ?? "").toLowerCase();
      items = COMMANDS.filter(([n]) => n.slice(1).startsWith(p)).slice(0, 8);
      menuOpen = items.length > 0;
      if (sel >= items.length) sel = 0;
    } else {
      menuOpen = false;
      items = [];
    }
  };

  const render = (): void => {
    let s = "\r\x1b[J" + PROMPT + line; // clear region, draw prompt + line
    if (menuOpen) {
      for (let i = 0; i < items.length; i++) {
        const [name, desc] = items[i]!;
        s +=
          i === sel
            ? `\n${C.cyan}› ${name}${C.reset}  ${C.dim}${desc}${C.reset}`
            : `\n  ${name}  ${C.dim}${desc}${C.reset}`;
      }
      s += `\n${C.dim}  ↑↓ navigate · Tab fill · Enter run · Esc dismiss${C.reset}`;
      s += `\x1b[${items.length + 1}A`; // move back up to the prompt line
    }
    const col = PROMPT_LEN + line.length;
    s += "\r" + (col > 0 ? `\x1b[${col}C` : "");
    out(s);
    promptShown = true;
  };

  const clearRegion = (): void => {
    if (promptShown) out("\r\x1b[J");
    promptShown = false;
  };

  const accept = (withSpace: boolean): void => {
    const picked = items[sel];
    if (!picked) return;
    line = picked[0] + (withSpace ? " " : "");
    refreshMenu(); // a trailing space closes the menu
    render();
  };

  const onKey = (str: string | undefined, key: readline.Key): void => {
    if (key.ctrl && key.name === "c") {
      ui.stop();
      ws.close();
      process.exit(0);
    }
    if (busy) return; // ignore input mid-turn

    switch (key.name) {
      case "return":
      case "enter":
        if (menuOpen) accept(false); // fill the highlighted command…
        clearRegion();
        submit(line); // …then run it
        line = "";
        return;
      case "tab":
        if (menuOpen) accept(true);
        else {
          refreshMenu();
          render();
        }
        return;
      case "escape":
        menuOpen = false;
        render();
        return;
      case "up":
        if (menuOpen) {
          sel = (sel - 1 + items.length) % items.length;
          render();
        }
        return;
      case "down":
        if (menuOpen) {
          sel = (sel + 1) % items.length;
          render();
        }
        return;
      case "backspace":
        if (line.length > 0) {
          line = line.slice(0, -1);
          refreshMenu();
          render();
        }
        return;
    }
    // Printable input (incl. paste): insert any non-control characters.
    if (str && !key.ctrl && !key.meta) {
      const printable = [...str].filter((ch) => ch >= " ").join("");
      if (printable) {
        line += printable;
        refreshMenu();
        render();
      }
    }
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", onKey);

  return {
    message(text, color = "") {
      if (busy) {
        out(`\n${color}${text}${C.reset}`);
      } else {
        clearRegion();
        out(`${color}${text.replace(/\n/g, "\n")}${C.reset}\n`);
        render();
      }
    },
    rearm() {
      line = "";
      menuOpen = false;
      render();
    },
    beginTurn() {
      // Echo the submitted line into the scrollback, then clear for output.
      clearRegion();
      out(`${PROMPT}${line}\n`);
      menuOpen = false;
    },
    stop() {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* not a TTY */
      }
      process.stdin.pause();
    },
  };
}

// ---- Line UI (non-TTY fallback: piped input, no menu) ---------------------
function createLineUI(): UI {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
  });
  rl.pause();

  rl.on("line", (l) => submit(l));
  rl.on("close", () => {
    stdinClosed = true;
    if (!busy) {
      ws.close();
      process.exit(0);
    }
  });

  return {
    message(text, color = "") {
      out(`\n${color}${text}${C.reset}`);
      if (!busy) {
        out("\n");
        rl.resume();
        rl.prompt();
      }
    },
    rearm() {
      out("\n");
      rl.resume();
      rl.prompt();
    },
    beginTurn() {
      rl.pause();
    },
    stop() {
      rl.close();
    },
  };
}

process.on("SIGINT", () => {
  ui.stop();
  ws.close();
  process.exit(0);
});
