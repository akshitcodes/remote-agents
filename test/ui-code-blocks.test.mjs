import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const marker = html.indexOf("// BEGIN code-block-metadata");
const sourceStart = html.indexOf("\n", marker) + 1;
const sourceEnd = html.indexOf("// END code-block-metadata", sourceStart);
const source = marker >= 0 && sourceEnd >= 0 ? html.slice(sourceStart, sourceEnd) : "";
assert.ok(source, "code-block metadata source must remain extractable");
const context = vm.createContext({ JSON });
vm.runInContext(`${source}\nthis.codeBlockMetadata = codeBlockMetadata;`, context);
const metadata = context.codeBlockMetadata;

test("fenced languages get stable human-readable labels", () => {
  assert.deepEqual(structuredClone(metadata("language-json", "{}")), { language: "json", label: "JSON", inferred: false });
  assert.equal(metadata("foo language-typescript bar", "const x = 1").label, "TypeScript");
  assert.equal(metadata("language-cpp", "int main() {}").label, "C++");
  assert.equal(metadata("language-graphql", "query X {}").label, "GraphQL");
});

test("valid unlabeled JSON is detected without reformatting ordinary text", () => {
  assert.deepEqual(structuredClone(metadata("", '{"count":0}')), { language: "json", label: "JSON", inferred: true });
  assert.equal(metadata("", "[1, 2, 3]").language, "json");
  assert.deepEqual(structuredClone(metadata("", "not { json }")), { language: null, label: "Plain text", inferred: false });
  assert.equal(metadata("", "{broken}").label, "Plain text");
  assert.equal(metadata("", `{"value":"${"x".repeat(200_001)}"}`).label, "Plain text");
});

test("final code cards are highlighted and copyable without decorating every stream delta", () => {
  assert.match(html, /function decorateCodeBlocks\(root\)/);
  assert.match(html, /window\.hljs\.highlightElement\(code\)/);
  assert.match(html, /function renderFinalMarkdownInto\(el, text\)/);
  assert.match(html, /navigator\.clipboard\?\.writeText/);
  assert.match(html, /FORBID_TAGS: \["button", "style"\]/);
  assert.match(html, /FORBID_ATTR: \["style", "hidden"\]/);
  assert.match(html, /className = "code-copy"/);
  assert.match(html, /copy\.dataset\.copyLabel = `Copy \$\{metadata\.label\} code`/);
  assert.match(html, /button\.dataset\.copyLabel \|\| "Copy code"/);
  assert.match(html, /copy\._codeEl = code/);
  assert.match(html, /copy\._copyText = sourceText/);
  assert.match(html, /const code = button\._codeEl/);
  assert.match(html, /writeClipboardText\(button\._copyText \|\| ""\)/);
  assert.doesNotMatch(html, /button\.closest\("\.code-card"\)/);
  assert.match(html, /sourceText\.length <= MAX_CODE_HIGHLIGHT_CHARS/);
  assert.match(html, /code\.textContent = sourceText/);
  assert.match(html, /function clearCarets\(\) \{[\s\S]*?renderFinalMarkdownInto\(el, el\._raw \|\| ""\)/);
  assert.match(html, /\$\("messages"\)\.addEventListener\("click"/);

  const appendAgent = html.match(/function appendAgent\(el, delta\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(appendAgent, /decorateCodeBlocks|highlightElement/);
});
