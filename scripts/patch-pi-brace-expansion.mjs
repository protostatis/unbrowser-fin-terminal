import { cpSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const expectedVersion = "5.0.8";
const source = path.resolve("node_modules/brace-expansion");
const target = path.resolve(
  "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
);

function packageVersion(directory) {
  const packageJson = JSON.parse(
    readFileSync(path.join(directory, "package.json"), "utf8"),
  );
  return packageJson.version;
}

if (packageVersion(source) !== expectedVersion) {
  throw new Error(`root brace-expansion must be ${expectedVersion}`);
}

// pi-coding-agent 0.83.0 ships an npm-shrinkwrap that bypasses root overrides.
// Replace only its nested copy from the exact, lockfile-verified root package.
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

if (packageVersion(target) !== expectedVersion) {
  throw new Error(`failed to install brace-expansion ${expectedVersion} for pi-coding-agent`);
}

console.log(`[postinstall] pi-coding-agent brace-expansion=${expectedVersion}`);
