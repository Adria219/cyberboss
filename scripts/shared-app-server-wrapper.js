const { spawn } = require("child_process");

function main() {
  const [entry, ...args] = process.argv.slice(2);
  if (!entry) {
    throw new Error("Codex app-server entry is required.");
  }

  const child = spawn(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });

  const forward = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.on("error", (error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
