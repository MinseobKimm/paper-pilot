import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = path.join(projectRoot, "release");
const source = path.join(projectRoot, "src-tauri", "target", "release", "bundle", "macos", "Paper Pilot.app");
const destination = path.join(releaseDir, "Paper Pilot.app");

if (!existsSync(source)) {
  throw new Error(`Built app is missing: ${source}`);
}

await mkdir(releaseDir, { recursive: true });
const stagingDir = await mkdtemp(path.join(releaseDir, ".paper-pilot-build-"));
const staged = path.join(stagingDir, "Paper Pilot.app");
const previous = path.join(stagingDir, "previous.app");
let hadPrevious = false;

try {
  execFileSync("/usr/bin/ditto", [source, staged]);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]);
  if (existsSync(destination)) {
    await rename(destination, previous);
    hadPrevious = true;
  }
  try {
    await rename(staged, destination);
  } catch (error) {
    if (hadPrevious) await rename(previous, destination);
    throw error;
  }
  console.log(`Updated ${destination}`);
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}
