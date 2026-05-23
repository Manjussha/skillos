// Layer 4 verification: drive remote access over a LOCAL WebSocket connection.
//
// Confirms, all offline (cloudflared is expected to be absent here):
//   1. /remote start mints a scoped, expiring token and prints a URL,
//   2. a QR (`type:"qr"`) + access URL are produced,
//   3. cloudflared-missing degrades gracefully (LOCAL stand-in, no crash),
//   4. /remote status reports running, /remote stop tears down + revokes.
//
// Run the server first (npm run dev:server), then: node scripts/verify-layer4.mjs
import WebSocket from "ws";

const URL = process.env.SKILLOS_URL ?? "ws://localhost:8787";
const ws = new WebSocket(URL);

let onboarding = false;
let phase = "init";

// Evidence collected from server messages.
const seen = {
  qr: false,
  url: false,
  token: false, // scopes + expiry line implies a minted token
  degraded: false, // graceful cloudflared-missing handling
  statusRunning: false,
  stopped: false,
};

const send = (text) => {
  console.log(`\n>>> ${text}`);
  ws.send(JSON.stringify({ type: "input", text }));
};

ws.on("open", () => {
  setTimeout(() => {
    if (onboarding) return;
    runRemote();
  }, 600);
});

function runRemote() {
  phase = "start";
  send("/remote start");
  setTimeout(() => {
    phase = "status";
    send("/remote status");
  }, 1500);
  setTimeout(() => {
    phase = "stop";
    send("/remote stop");
  }, 3000);
  setTimeout(finish, 4500);
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === "qr") {
    seen.qr = true;
    if (msg.url) seen.url = true;
    console.log("(qr) <QR art received>");
    console.log(`(qr) url: ${msg.url}`);
    return;
  }
  if (msg.type === "info") {
    console.log(`(info) ${msg.text}`);
    handleOnboarding(msg.text);
    if (/Access:\s*http/i.test(msg.text)) seen.url = true;
    if (/Scopes:|Expires:/i.test(msg.text)) seen.token = true;
    if (/LOCAL stand-in|cloudflared is not installed|Falling back to LOCAL/i.test(msg.text))
      seen.degraded = true;
    if (phase === "status" && /Remote access: running/i.test(msg.text))
      seen.statusRunning = true;
    if (phase === "stop" && /Remote access stopped/i.test(msg.text))
      seen.stopped = true;
    return;
  }
  if (msg.type === "error") {
    console.log(`(error) ${msg.text}`);
    return;
  }
  if (msg.type === "done") {
    console.log(`[done: ${msg.meta.model} via ${msg.meta.provider}]`);
  }
});

// Tolerate a fresh-db onboarding prompt (same approach as verify-layer3).
function handleOnboarding(text) {
  if (/personalize SkillOS|use SkillOS for/i.test(text)) {
    onboarding = true;
    setTimeout(() => send("1"), 300);
  } else if (onboarding && /Preferred stack/i.test(text)) {
    setTimeout(() => send("react, node"), 300);
  } else if (onboarding && /Preferred mode/i.test(text)) {
    setTimeout(() => send("1"), 300);
  } else if (onboarding && /Profile saved/i.test(text)) {
    onboarding = false;
    setTimeout(runRemote, 400);
  }
}

function finish() {
  const checks = [
    ["token minted (scopes + expiry)", seen.token],
    ["access URL produced", seen.url],
    ["QR code produced", seen.qr],
    ["cloudflared-missing degraded gracefully", seen.degraded],
    ["/remote status reports running", seen.statusRunning],
    ["/remote stop tears down", seen.stopped],
  ];
  console.log("\n--- layer 4 verification ---");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }
  console.log(`\nresult → ${ok ? "PASS" : "FAIL"}`);
  ws.close();
  process.exit(ok ? 0 : 1);
}

setTimeout(() => {
  console.log("\n(timeout — closing)");
  finish();
}, 30000);

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});
