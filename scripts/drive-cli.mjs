// Test harness: drive the interactive CLI like a human would — one line per
// second into a kept-open stdin — so we exercise the real prompt/turn flow.
import { spawn } from "node:child_process";

const lines = process.env.CLI_LINES
  ? process.env.CLI_LINES.split("|")
  : ["1", "skip", "2", "3", "/help", "/skills", "/profile", "/seo printers", "/exit"];

const child = spawn("npx", ["tsx", "apps/cli/src/index.ts"], {
  stdio: ["pipe", "inherit", "inherit"],
  shell: true,
});

let i = 0;
const timer = setInterval(() => {
  if (i >= lines.length) {
    clearInterval(timer);
    return;
  }
  child.stdin.write(lines[i++] + "\n");
}, 1000);

child.on("exit", (code) => {
  clearInterval(timer);
  process.exit(code ?? 0);
});
