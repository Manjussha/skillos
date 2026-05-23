// Smoke test: drive the SkillOS core loop over WebSocket.
// Sends a sequence of commands on a timer and prints server responses.
import WebSocket from "ws";

const URL = process.env.SKILLOS_URL ?? "ws://localhost:8787";
const commands = ["/help", "/skills", "/models", "/use claude", "/seo a printing business"];
const SPACING_MS = 2000;

const ws = new WebSocket(URL);

ws.on("open", () => {
  commands.forEach((cmd, i) => {
    setTimeout(() => {
      console.log(`\n>>> ${cmd}`);
      ws.send(JSON.stringify({ type: "input", text: cmd }));
    }, 300 + i * SPACING_MS);
  });
  // close a bit after the last command has had time to stream
  setTimeout(() => {
    console.log("\n--- smoke test complete ---");
    ws.close();
    process.exit(0);
  }, 600 + commands.length * SPACING_MS);
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "chunk") process.stdout.write(msg.text);
  else if (msg.type === "done") console.log(`\n[done: ${msg.meta.model} via ${msg.meta.provider}]`);
  else if (msg.type === "info") console.log(`(info) ${msg.text}`);
  else if (msg.type === "error") console.log(`(error) ${msg.text}`);
});

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});
