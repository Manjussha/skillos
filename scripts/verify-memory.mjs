// Cross-session memory verification (Feature B).
//
// 1. Open a WS connection, send a couple of inputs (a skill + a free prompt
//    mentioning a memorable fact), then close.
// 2. Wait ~2s so the server's compress-on-close finishes writing the doc.
// 3. Open a NEW connection and assert the greeting includes the recalled-memory
//    line ("🧠 Recalled memory from previous sessions:").
//
// Modeled on scripts/smoke.mjs / drive-cli.mjs. Exits 0 on success, 1 on failure.
import WebSocket from "ws";

const URL = process.env.SKILLOS_URL ?? "ws://localhost:8787";
const MEMORABLE = "my favorite color is chartreuse";

/** Run one connection: send `inputs` (with spacing), collect all info text. */
function session(inputs, { holdMs = 1500 } = {}) {
  return new Promise((resolveSession, reject) => {
    const ws = new WebSocket(URL);
    const infos = [];
    let done = 0;

    ws.on("open", () => {
      inputs.forEach((text, i) => {
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "input", text }));
        }, 300 + i * 1500);
      });
      // Close after the last input has had time to stream a `done`.
      setTimeout(
        () => ws.close(),
        300 + inputs.length * 1500 + holdMs,
      );
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "info") infos.push(msg.text);
      else if (msg.type === "done") done++;
    });

    ws.on("close", () => resolveSession({ infos, done }));
    ws.on("error", reject);
  });
}

async function main() {
  console.log(">>> session 1: seeding memory");
  const first = await session([
    "/seo printers",
    `Remember this: ${MEMORABLE}.`,
  ]);
  console.log(`    sent 2 inputs, received ${first.done} done signal(s)`);

  console.log(">>> waiting 2s for compress-on-close…");
  await new Promise((r) => setTimeout(r, 2000));

  console.log(">>> session 2: expecting recalled memory in the greeting");
  const second = await session([], { holdMs: 1500 });

  const recallLine = second.infos.find((t) =>
    t.includes("Recalled memory from previous sessions"),
  );

  if (!recallLine) {
    console.error("\n[FAIL] No recalled-memory line in the new session greeting.");
    console.error("Greeting infos were:\n" + second.infos.join("\n---\n"));
    process.exit(1);
  }

  console.log("\n[PASS] Recalled-memory line present:");
  console.log(recallLine);
  console.log("\n--- verify-memory complete ---");
  process.exit(0);
}

main().catch((e) => {
  console.error("verify-memory error:", e.message);
  process.exit(1);
});
