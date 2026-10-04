import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mac = process.platform === "darwin";
const windows = process.platform === "win32";
const venv = mac
  ? join(homedir(), "Library", "Application Support", "local.paper-pilot.reader", "python")
  : join(root, ".venv");
const python = join(venv, windows ? "Scripts/python.exe" : "bin/python3");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} exited with ${result.status}`);
  }
}

if (!existsSync(python)) {
  const candidates = [
    [process.env.PAPER_PILOT_PYTHON, []],
    ["python3.12", []],
    ["/opt/homebrew/bin/python3.12", []],
    ["/usr/local/bin/python3.12", []],
    ["python3", []],
    ["python", []],
    ...(windows ? [["py", ["-3"]]] : []),
  ];
  const match = candidates.find(([command, prefix]) => command && spawnSync(command, [
    ...prefix, "-c", "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)",
  ]).status === 0);
  if (!match) throw new Error("Python 3.11+ is required. On macOS: brew install python@3.12");
  mkdirSync(dirname(venv), { recursive: true });
  run(match[0], [...match[1], "-m", "venv", venv]);
}
run(python, ["-m", "pip", "install", "-r", join(root, "requirements.txt")]);
run(python, ["-c", "import paperqa; print('PaperQA ready')"]);
console.log(`Paper Pilot retrieval Python: ${python}`);
