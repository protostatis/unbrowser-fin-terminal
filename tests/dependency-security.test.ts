import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.resolve(relativePath), "utf8")) as Record<string, unknown>;
}

test("the Pi agent uses the patched brace-expansion runtime", () => {
  const rootPackage = readJson("package.json") as {
    dependencies?: Record<string, string>;
  };
  const lockfile = readJson("package-lock.json") as {
    packages?: Record<string, { version?: string }>;
  };
  const installed = readJson(
    "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json",
  ) as { version?: string };

  assert.equal(rootPackage.dependencies?.["brace-expansion"], "5.0.8");
  assert.equal(
    lockfile.packages?.[
      "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"
    ]?.version,
    "5.0.8",
  );
  assert.equal(installed.version, "5.0.8");
});
