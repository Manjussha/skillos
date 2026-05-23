// Layer 2 verification: drive onboarding → /profile → /generate-skills over WS.
// Sequences input with enough spacing for the server to reply each step.
import WebSocket from "ws";

const URL = process.env.SKILLOS_URL ?? "ws://localhost:8787";
const steps = [
  "7", // use-case: Business
  "react, node", // stack
  "2", // mode: Best quality
  "1", // provider: OpenRouter (triggers the API-key step)
  "skip", // API key: skip (exercises the key step without writing a real key)
  "/profile",
  "/generate-skills I run a printing business",
  "/skills",
];
const SPACING_MS = 1200;
const ws = new WebSocket(URL);

ws.on("open", () => {
  steps.forEach((cmd, i) => {
    setTimeout(() => {
      console.log(`\n>>> ${cmd}`);
      ws.send(JSON.stringify({ type: "input", text: cmd }));
    }, 500 + i * SPACING_MS);
  });
  setTimeout(() => {
    console.log("\n--- layer2 verify complete ---");
    ws.close();
    process.exit(0);
  }, 1500 + steps.length * SPACING_MS);
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
