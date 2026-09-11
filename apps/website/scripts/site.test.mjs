import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { releaseLinks, RELEASES_URL } from "../frontend/src/services/releases.ts";
import { docPages, docGroups, docHref, searchDocs } from "../frontend/src/docs/content.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("documentation search finds the right guides and every guide link resolves", async () => {
  assert.equal(new Set(docPages.map(page => page.slug)).size, docPages.length);
  assert.ok(docPages.length >= 15);
  assert.equal(searchDocs("  ").length, 0);
  assert.equal(searchDocs("zzzz-nonexistent-guide").length, 0);
  assert.equal(searchDocs("Hey Lina")[0].page.slug, "voice");
  assert.equal(searchDocs("Open Codex")[0].page.slug, "open-codex");
  assert.equal(searchDocs("Models providers")[0].page.slug, "providers");
  assert.ok(searchDocs("microphone privacy").some(result => result.page.slug === "troubleshooting"));
  const paths = new Map(docPages.map(page => [docHref(page.slug), page]));
  for (const page of docPages) {
    assert.ok(docGroups.includes(page.group), page.title);
    assert.ok(page.sections.length >= 3, page.title);
    assert.equal(new Set(page.sections.map(section => section.id)).size, page.sections.length, page.title);
    for (const section of page.sections) for (const block of section.blocks) {
      if (block.type === "cards") for (const link of block.items) {
        if (!link.href.startsWith("/docs")) continue;
        const [pathname, hash] = link.href.split("#");
        const target = paths.get(pathname);
        assert.ok(target, link.href);
        if (hash) assert.ok(target.sections.some(item => item.id === hash), link.href);
      }
      if (block.type === "image") assert.ok((await readFile(path.join(root, "frontend/public", block.src))).length > 10000);
    }
  }
  for (const result of searchDocs("voice")) {
    assert.ok(paths.has(docHref(result.page.slug)));
    if (result.section) assert.ok(result.page.sections.some(section => section.id === result.section.id));
  }
});

test("download selects the Windows installer, not update metadata or its blockmap", () => {
  const installer = { name: "LinaTerminal-Setup-0.1.115.exe", downloadUrl: "https://example.com/app.exe" };
  const release = { assets: [
    { name: "latest.yml", downloadUrl: "https://example.com/latest.yml" },
    { name: "LinaTerminal-Setup-0.1.115.exe.blockmap", downloadUrl: "https://example.com/app.blockmap" },
    installer
  ], htmlUrl: "https://example.com/release" };
  assert.equal(releaseLinks(release).downloadUrl, installer.downloadUrl);
  assert.equal(releaseLinks(release).hasInstaller, true);
  assert.equal(releaseLinks(release).notesUrl, release.htmlUrl);
  assert.equal(releaseLinks(null).downloadUrl, RELEASES_URL);
  assert.equal(releaseLinks({ assets: release.assets.slice(0, 2) }).hasInstaller, false);
  assert.equal(releaseLinks({ assets: [{ ...installer, name: "vibeTerminal-Setup-0.1.0.exe" }] }).hasInstaller, true);
});

test("production server serves every product route, assets, and the signup API", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "lina-website-smoke-"));
  process.env.WAITLIST_FILE_PATH = path.join(temporary, "waitlist.json");
  const { createApp } = await import("../backend/src/app.ts");
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ["/", "/fusion", "/open-fusion", "/orchestrator", "/agents", "/voice", "/pricing", ...docPages.map(page => docHref(page.slug))]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get("content-type"), /text\/html/);
      assert.match(await response.text(), /Lina Terminal/);
    }
    for (const image of ["workspace.png", "fusion.png", "open-fusion.png", "orchestrator.png", "voice-settings.png"]) {
      const response = await fetch(`${base}/screenshots/${image}`);
      assert.equal(response.status, 200, image);
      assert.match(response.headers.get("content-type"), /image\/png/);
      const buffer = Buffer.from(await response.arrayBuffer());
      assert.equal(buffer.readUInt32BE(0), 0x89504e47);
      assert.ok(buffer.length > 10000);
      assert.ok(buffer.readUInt32BE(16) >= 1200);
    }
    const assets = await readdir(path.join(root, "frontend/dist/assets"));
    for (const image of ["/brand/lina-mark.svg", "/brand/lina-logo.png", "/brand/lina-logo.ico", "/favicon.ico"]) {
      const response = await fetch(base + image);
      assert.equal(response.status, 200, image);
      assert.ok(Number(response.headers.get("content-length")) > 100);
    }
    for (const asset of assets.filter(name => /\.(js|css)$/.test(name))) {
      assert.equal((await fetch(`${base}/assets/${asset}`)).status, 200, asset);
    }
    assert.equal((await fetch(base + "/api/health")).status, 200);
    assert.equal((await fetch(base + "/api/not-a-route")).status, 404);
    const send = email => fetch(base + "/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, source: "local-smoke-test" }) });
    assert.equal((await send("not-an-email")).status, 400);
    const created = await send("smoke@example.test");
    assert.equal(created.status, 201);
    assert.equal((await created.json()).status, "joined");
    const duplicate = await send("SMOKE@example.test");
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).status, "already_joined");
    const entries = JSON.parse(await readFile(process.env.WAITLIST_FILE_PATH, "utf8"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].email, "smoke@example.test");
    for (const body of [{ email: 42 }, { email: "valid@example.test", source: {} }]) {
      const response = await fetch(base + "/api/waitlist", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      assert.equal(response.status, 400, "invalid signup fields must be rejected as client errors");
    }
    const concurrent = await Promise.all(Array.from({ length: 20 }, (_, index) => send(`parallel-${index}@example.test`)));
    assert.ok(concurrent.every(response => response.status === 201));
    const saved = JSON.parse(await readFile(process.env.WAITLIST_FILE_PATH, "utf8"));
    assert.equal(saved.length, 21, "simultaneous signups must all survive");
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => send("duplicate@example.test")));
    assert.equal(duplicates.filter(response => response.status === 201).length, 1);
    assert.equal(duplicates.filter(response => response.status === 200).length, 7);
    for (const corrupt of ["{broken", "{}", '[{"email":null}]']) {
      await writeFile(process.env.WAITLIST_FILE_PATH, corrupt);
      assert.equal((await send("preserve@example.test")).status, 500);
      assert.equal(await readFile(process.env.WAITLIST_FILE_PATH, "utf8"), corrupt, "invalid stores must remain intact");
    }
    await writeFile(process.env.WAITLIST_FILE_PATH, JSON.stringify(saved));
    assert.equal((await send("recovered@example.test")).status, 201, "a failed write must not poison later requests");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
