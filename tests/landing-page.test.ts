// The static landing page served at `/` (index.html at the repository root).
// Checks only that the required content points are present and that the page
// stays self-contained (no scripts or external assets).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(REPO_ROOT, "index.html"), "utf8");

test("landing page names the project and links to the source code", () => {
  assert.match(html, /<title>slack-github-bot<\/title>/);
  assert.match(html, /<h1>slack-github-bot<\/h1>/);
  assert.match(html, /href="https:\/\/github\.com\/runethorbek\/slack-github-bot"/);
  assert.match(html, /welcome to clone it and adapt it/);
});

test("landing page says the deployment is private and not a public service", () => {
  assert.match(html, /for personal, private use/);
  assert.match(html, /not a public service/);
});

test("landing page lists the technologies used", () => {
  for (const name of ["Slack", "Notion", "Gemini", "Vercel"]) {
    assert.match(html, new RegExp(`<li>${name}</li>`));
  }
});

test("landing page is self-contained", () => {
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<link/i);
  assert.doesNotMatch(html, /\/api\//);
});
