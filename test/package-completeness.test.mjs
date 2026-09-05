import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// npm's `files` accepts bare paths and directory prefixes. Mirror just enough
// of that to answer "would this file be in the tarball?".
function isPublished(relPath) {
  return pkg.files.some((entry) => {
    const clean = entry.replace(/^\.\//, "");
    return clean.endsWith("/") ? relPath.startsWith(clean) : relPath === clean;
  });
}

// Every relative import reachable from the package's entry points, transitively.
function reachableLocalModules(entries) {
  const seen = new Set();
  const queue = [...entries.map((entry) => resolve(root, entry))];

  while (queue.length) {
    const file = queue.pop();
    const rel = relative(root, file);

    if (seen.has(rel) || !existsSync(file)) { continue; }

    seen.add(rel);
    const source = readFileSync(file, "utf8");

    for (const match of source.matchAll(/(?:^|\s)(?:import|export)[\s\S]{0,400}?from\s+["'](\.[^"']+)["']/g)) {
      queue.push(resolve(dirname(file), match[1]));
    }
    for (const match of source.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      queue.push(resolve(dirname(file), match[1]));
    }
  }

  return [...seen];
}

test("every module the bridge imports is actually published", () => {
  // The failure this guards against is silent and total: npm packs a tarball
  // whose entry point imports a file that is not in it, and the bridge dies on
  // startup for everyone who installs it. Local test runs never notice,
  // because the file is right there on disk.
  const missing = reachableLocalModules([pkg.bin["remote-agents"], "server.mjs"])
    .filter((rel) => !isPublished(rel));

  assert.deepEqual(missing, [], `not in package.json "files": ${missing.join(", ")}`);
});

test("declared entry points and published assets exist on disk", () => {
  assert.ok(existsSync(join(root, pkg.bin["remote-agents"])), "bin entry point is missing");

  for (const entry of pkg.files) {
    const clean = entry.replace(/^\.\//, "").replace(/\/$/, "");
    assert.ok(existsSync(join(root, clean)), `package.json "files" lists a missing path: ${entry}`);
  }
});
