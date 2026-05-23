import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/** Server → client message shape (mirrors apps/server/src/types.ts). */
type ServerMessage =
  | { type: "chunk"; text: string }
  | { type: "info"; text: string }
  | { type: "error"; text: string }
  | { type: "done"; meta: { skill: string | null; model: string; provider: string } }
  | {
      type: "stage";
      agent: string;
      step: number;
      total: number;
      model: string;
      provider: string;
    }
  // Layer 4: a QR code as terminal art plus the URL it encodes.
  | { type: "qr"; art: string; url: string }
  // Layer 4: a confirmation prompt for a privileged tool over a remote session.
  | {
      type: "permission-request";
      id: string;
      target: string;
      scopes: string[];
      text: string;
    };

// Client → server messages (mirrors apps/server/src/types.ts ClientMessage).
type ClientMessage =
  | { type: "input"; text: string }
  | { type: "auth"; token: string }
  | { type: "permission-response"; id: string; approved: boolean };

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "ws://localhost:8787";

// ANSI helpers
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[1;32m";
const CYAN = "\x1b[1;36m";

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 14,
      cursorBlink: true,
      theme: { background: "#0b0e14", foreground: "#c8d3f5" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    let line = "";
    let busy = false;
    let pendingNewline = false;
    // Layer 4: a permission prompt awaiting a y/n answer, or null.
    let pendingPermission: { id: string } | null = null;

    const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

    // Layer 4: a remote client carries its token in the URL fragment
    // (#token=...). Local connections have no token and stay fully trusted.
    const tokenFromHash = (): string | null => {
      const m = /token=([a-f0-9]+)/i.exec(window.location.hash);
      return m?.[1] ?? null;
    };

    const prompt = () => {
      busy = false;
      pendingNewline = false;
      term.write(`\r\n${GREEN}skillos>${RESET} `);
    };

    const writeBlock = (text: string, color = "") => {
      term.write(`\r\n${color}${text.replace(/\n/g, "\r\n")}${RESET}`);
    };

    term.writeln(`${GREEN}SkillOS${RESET} ${DIM}— connecting to ${SERVER_URL}…${RESET}`);

    const ws = new WebSocket(SERVER_URL);

    ws.onopen = () => {
      // Present a token if we have one (remote client); local clients skip this.
      const token = tokenFromHash();
      if (token) send({ type: "auth", token });
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "info":
          writeBlock(msg.text, DIM);
          pendingNewline = true;
          if (!busy) prompt();
          break;
        case "chunk":
          if (pendingNewline) {
            term.write("\r\n");
            pendingNewline = false;
          }
          term.write(msg.text.replace(/\n/g, "\r\n"));
          break;
        case "error":
          writeBlock(msg.text, RED);
          prompt();
          break;
        case "done":
          // Empty model = a non-streaming turn-end signal: rearm the prompt
          // without printing a meta line.
          if (msg.meta.model) {
            writeBlock(`[${msg.meta.model} via ${msg.meta.provider}]`, DIM);
          }
          prompt();
          break;
        case "stage":
          // Structural marker for agent pipelines. The server also emits a
          // readable `info` header (so older clients still see progress); we
          // just render a compact colored banner here for emphasis.
          writeBlock(
            `■ ${msg.agent} [${msg.step}/${msg.total}] (${msg.model})`,
            CYAN,
          );
          pendingNewline = true;
          break;
        case "qr":
          // QR art is already newline-delimited; write it raw, then the URL.
          writeBlock(msg.art, CYAN);
          writeBlock(`Access URL: ${msg.url}`, GREEN);
          pendingNewline = true;
          if (!busy) prompt();
          break;
        case "permission-request":
          // A privileged tool wants to run over a remote session. Ask y/n.
          pendingPermission = { id: msg.id };
          writeBlock(msg.text, CYAN);
          writeBlock("Approve? [y/N] ", GREEN);
          busy = false; // allow typing the answer
          break;
      }
    };

    ws.onclose = () => {
      writeBlock("Disconnected from server.", RED);
    };

    term.onData((data) => {
      if (busy) return; // ignore input while a turn is in flight
      const code = data.charCodeAt(0);
      if (data === "\r") {
        const input = line.trim();
        line = "";
        // Layer 4: answering a pending permission prompt.
        if (pendingPermission) {
          const approved = /^y(es)?$/i.test(input);
          send({ type: "permission-response", id: pendingPermission.id, approved });
          pendingPermission = null;
          busy = true; // the turn resumes server-side
          pendingNewline = false;
          term.write("\r\n");
          return;
        }
        if (!input) {
          prompt();
          return;
        }
        busy = true;
        pendingNewline = false;
        send({ type: "input", text: input });
      } else if (code === 0x7f || code === 0x08) {
        // backspace / delete
        if (line.length > 0) {
          line = line.slice(0, -1);
          term.write("\b \b");
        }
      } else if (code === 0x03) {
        // ctrl-c
        line = "";
        term.write("^C");
        prompt();
      } else if (code >= 0x20) {
        // printable
        line += data;
        term.write(data);
      }
    });

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      ws.close();
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="h-full w-full p-2" />;
}
