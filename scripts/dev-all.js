const { spawn } = require("child_process");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

function startProcess(name, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    shell: true,
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[${name}] exited with ${reason}`);
    shutdown(code ?? 1);
  });

  child.on("error", (error) => {
    if (shuttingDown) {
      return;
    }

    console.error(`[${name}] failed to start`, error);
    shutdown(1);
  });

  return child;
}

const children = [];
let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }

  setTimeout(() => process.exit(exitCode), 200);
}

children.push(
  startProcess("backend", "node", ["index.js"], path.join(rootDir, "src", "server")),
  startProcess("frontend", "npm", ["start"], rootDir)
);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
