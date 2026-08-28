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
  assert.match(html, /document\.addEventListener\("click"[\s\S]*?copyCodeBlock\(copy\)/);

  const appendAgent = html.match(/function appendAgent\(el, delta\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(appendAgent, /decorateCodeBlocks|highlightElement/);
});

test("Mermaid is lazy, bounded, sanitized, and absent from the streaming path", () => {
  assert.match(html, /mermaid: "Mermaid"/);
  assert.match(html, /script\.src = "\/vendor\/mermaid\.min\.js"/);
  assert.match(html, /securityLevel: "strict"/);
  assert.match(html, /maxTextSize: MAX_MERMAID_CHARS/);
  assert.match(html, /maxEdges: 500/);
  assert.match(html, /new IntersectionObserver/);
  assert.match(html, /rootMargin: "320px 0px"/);
  assert.match(html, /mermaidRenderQueue = mermaidRenderQueue\.then/);
  assert.match(html, /const mermaid = await loadMermaid\(\);\s*if \(!card\.isConnected\) \{ return; \}/);
  assert.match(html, /USE_PROFILES: \{ svg: true, svgFilters: true \}/);
  assert.match(html, /metadata\.language === "mermaid"/);
  assert.match(html, /scheduleMermaidBlocks\(el\)/);

  const appendAgent = html.match(/function appendAgent\(el, delta\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(appendAgent, /mermaid|scheduleMermaidBlocks|loadMermaid/);
});

test("HTML files render only in a scriptless isolated preview with source fallback", () => {
  assert.match(html, /const HTML_FILE_RE = \/\\\.html\?\$\/i/);
  assert.match(html, /const MAX_HTML_PREVIEW_CHARS = 750_000/);
  assert.match(html, /<iframe class="html-preview" title="HTML preview" sandbox=""/);
  assert.match(html, /default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:/);
  assert.match(html, /Raw project HTML never enters the app DOM/);
  assert.match(html, /FORBID_TAGS: \["script", "base", "iframe", "object", "embed"\]/);
  assert.match(html, /meta\.getAttribute\("http-equiv"\).*=== "refresh"/);
  assert.match(html, /querySelectorAll\("a\[href\], area\[href\]"\)/);
  assert.match(html, /code\.textContent = d\.content/);
  assert.match(html, /data-view="source"/);
  assert.match(html, /function closeSheet\(\) \{[\s\S]*?frame\.srcdoc = ""/);
});
