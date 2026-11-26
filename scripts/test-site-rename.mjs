import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Load the Worker as an ES module without imposing a package.json on this repo.
const source = await readFile(new URL("../site-worker.js", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("the site advertises portable move and back shortcuts", async () => {
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  assert.match(html, /<kbd>F6<\/kbd>/);
  assert.match(html, /Return to BetterAgentView<\/td><td><kbd>F7<\/kbd>/);
  assert.doesNotMatch(html, /<kbd>(Ctrl\+M|Shift\+&larr;)<\/kbd>/);
});

test("install commands wrap rather than showing a horizontal scrollbar", async () => {
  const css = await readFile(new URL("../site/landing.css", import.meta.url), "utf8");
  const rule = css.match(/\.install-command code\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule, "the install command has a layout rule");
  assert.match(rule, /min-width:\s*0/);
  assert.match(rule, /white-space:\s*pre-wrap/);
  assert.match(rule, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(rule, /overflow(?:-x)?:\s*(?:auto|scroll|hidden)/);
});

for (const host of ["agent-view.app", "www.agent-view.app", "www.betteragentview.com"]) {
  test(`${host} redirects permanently, retaining paths and query strings`, async () => {
    const response = await worker.fetch(new Request(`https://${host}/film.mp4?v=2`), {});
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("Location"), "https://betteragentview.com/film.mp4?v=2");
  });
}

test("the canonical domain serves assets rather than redirecting to itself", async () => {
  const request = new Request("https://betteragentview.com/favicon.svg");
  const response = await worker.fetch(request, { ASSETS: { fetch: async (received) => {
    assert.equal(received, request);
    return new Response("asset");
  } } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "asset");
});
