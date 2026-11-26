import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../site/", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const css = await readFile(new URL("landing.css", root), "utf8");

test("one launch film, no duplicate looping video", () => {
  assert.equal((html.match(/<video\b/g) || []).length, 1);
  assert.ok(html.includes('src="/film.mp4"'));
  assert.ok(!html.includes('src="/demo.mp4"'));
  assert.ok(!html.includes("autoplay"));
  assert.ok(html.includes('src="/demo.gif"'));
});

test("directory-first examples and honest voice scope are visible", () => {
  assert.match(html, /aria-pressed="true" data-view="directories"/);
  assert.match(html, /Voice integrations currently support OpenCode sessions/);
  assert.match(html, /docs\/mobile-bridge\.md/);
  assert.match(html, /Ctrl<\/kbd><kbd>S<\/kbd> toggles grouping/);
});

test("prominent GitHub call to action and working install alternatives", () => {
  assert.match(html, /class="button github-button"/);
  assert.match(html, /Star on GitHub/);
  for (const command of ["install.sh | bash", "install.ps1 | iex", "cargo install --locked"]) assert.ok(html.includes(command));
  assert.match(css, /\.button\{[^}]*background:var\(--ink\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
});

test("every local asset and fragment exists", async () => {
  for (const [, path] of html.matchAll(/(?:src|poster|href)="(\/[^"#?]*)"/g)) {
    const file = new URL(`.${path}`, root);
    const info = await stat(file);
    assert.ok(info.isFile() || info.isDirectory(), path);
  }
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(html.includes(`id="${id}"`), id);
  const catalog = JSON.parse(await readFile(new URL("../docs/harnesses.json", import.meta.url), "utf8"));
  const harnesses = html.split('<div class="harnesses">')[1].split("</div>")[0];
  assert.equal((harnesses.match(/<a /g) || []).length, catalog.codingHarnesses.length + 1);
  for (const harness of catalog.codingHarnesses) assert.ok(harnesses.includes(harness.name), harness.name);
});
