import assert from "node:assert/strict";
import test from "node:test";

import { createIndexShellReader } from "../onboarding.mjs";

test("UI shell refresh keeps the last complete file during an in-place package upgrade", () => {
  const reads = ["first shell", "updated shell", new Error("package file is temporarily absent")];
  const readShell = createIndexShellReader("index.html", () => {
    const next = reads.shift();
    if (next instanceof Error) { throw next; }
    return next;
  });

  assert.equal(readShell(), "updated shell");
  assert.equal(readShell(), "updated shell");
});
