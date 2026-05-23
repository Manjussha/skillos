import readline from "node:readline";
import { WebSocket } from "ws";

/**
 * SkillOS native terminal client.
 *
 * A thin CLI over the same WebSocket protocol the browser terminal uses. On a
 * real terminal (TTY) it renders a Claude-Code-style bordered input box with a
 * live, navigable slash-command menu (type "/", ↑/↓ to move, Tab to fill, Enter
 * to run, Esc to dismiss). When piped / non-interactive it falls back to plain
 * line input. It renders every server message type and sends every client one.
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
  ["/connect", "connect a bridge: /connect shell|aider|gemini|…"],
  ["/bridges", "list connected bridges"],
  ["/run", "run a skill or bridge command"],
  ["/exit", "quit the CLI"],
];

// ---- Shared turn state ----------------------------------------------------
let busy = false;
let pendingNewline = false;
let pendingPermission: string | null = null;
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
    ui.beginTurn(t);
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
  ui.beginTurn(t);
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
  message(text: string, color?: string): void;
  rearm(): void;
  beginTurn(echo: string): void;
  stop(): void;
}

const isTTY = Boolean(process.stdin.isTTY);
const ui: UI = isTTY ? createInteractiveUI() : createLineUI();

// ---- Interactive UI (raw mode, bordered input box + slash menu) -----------
function createInteractiveUI(): UI {
  let line = "";
  let menuOpen = false;
  let items: [string, string][] = [];
  let sel = 0;
  let shown = false; // a box is currently drawn; cursor rests on its content line

  const boxWidth = (): number =>
    Math.max(40, Math.min(process.stdout.columns || 80, 100));

  const refreshMenu = (): void => {
    const m = /^\/(\S*)$/.exec(line);
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

  /** Draw the input box (and menu); leaves the cursor inside the box. */
  const render = (): void => {
    const W = boxWidth();
    const inner = W - 4; // between "│ " and " │"
    const text = "> " + line;
    const vis = text.length > inner ? text.slice(text.length - inner) : text;
    const pad = " ".repeat(Math.max(0, inner - vis.length));
    const body =
      text.length > inner ? vis : `${C.green}> ${C.reset}${line}`;
    const top = `${C.dim}╭${"─".repeat(W - 2)}╮${C.reset}`;
    const mid = `${C.dim}│${C.reset} ${body}${pad} ${C.dim}│${C.reset}`;
    const bot = `${C.dim}╰${"─".repeat(W - 2)}╯${C.reset}`;

    let s = shown ? "\x1b[1A\r\x1b[J" : "\r\x1b[J"; // clear old box region
    s += `${top}\n${mid}\n${bot}`;
    let below = 1; // bottom border sits below the content line
    if (menuOpen) {
      for (let i = 0; i < items.length; i++) {
        const [n, d] = items[i]!;
        s +=
          "\n" +
          (i === sel
            ? `${C.cyan}› ${n}${C.reset}  ${C.dim}${d}${C.reset}`
            : `  ${n}  ${C.dim}${d}${C.reset}`);
        below++;
      }
      s += `\n${C.dim}  ↑↓ navigate · Tab fill · Enter run · Esc dismiss${C.reset}`;
      below++;
    }
    s += `\x1b[${below}A\r`; // back up to the content line, column 0
    const col = 2 + vis.length; // after "│ " + visible text
    if (col > 0) s += `\x1b[${col}C`;
    out(s);
    shown = true;
  };

  /** Erase the box region so server output can be printed cleanly above it. */
  const clearRegion = (): void => {
    if (shown) {
      out("\x1b[1A\r\x1b[J");
      shown = false;
    }
  };

  const accept = (withSpace: boolean): void => {
    const picked = items[sel];
    if (!picked) return;
    line = picked[0] + (withSpace ? " " : "");
    refreshMenu();
    render();
  };

  const onKey = (str: string | undefined, key: readline.Key): void => {
    if (key.ctrl && key.name === "c") {
      ui.stop();
      ws.close();
      process.exit(0);
    }
    if (busy) return;

    switch (key.name) {
      case "return":
      case "enter": {
        if (menuOpen) {
          const p = items[sel];
          if (p) line = p[0];
          menuOpen = false;
        }
        const text = line;
        line = "";
        submit(text); // beginTurn() clears the box + echoes
        return;
      }
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
        out(`${color}${text}${C.reset}\n`);
        render();
      }
    },
    rearm() {
      line = "";
      menuOpen = false;
      render();
    },
    beginTurn(echo) {
      clearRegion();
      out(`${C.green}>${C.reset} ${echo}\n`); // echo into scrollback
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

// ---- Line UI (non-TTY fallback: piped input, no box/menu) -----------------
function createLineUI(): UI {
  const PROMPT = `${C.green}skillos>${C.reset} `;
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
