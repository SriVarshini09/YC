import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WatchSourceSchema, checkSource, pageText, runWatch, type WatchSource } from "@shapi/canary";

// Execution plan C-01: page watchers behind fetch guards.
const filler = (n: number) => Array.from({ length: n }, (_, i) => `<p>Entry ${i}: something changed in the API on day ${i}.</p>`).join("\n");
const page = (extra = "", entries = 60) => `<html><head><style>p{}</style><script>var t=Date.now()</script></head><body><h1>Changelog</h1>${filler(entries)}${extra}</body></html>`;
const source = (over: Partial<WatchSource> = {}): WatchSource => WatchSourceSchema.parse({ id: "acme-changelog", provider: "acme", url: "https://docs.acme.test/changelog", markers: ["Changelog"], ...over });
const serve = (status: number, body = "", headers: Record<string, string> = {}) => (async () => new Response(status >= 300 && status < 400 ? null : body, { status, headers })) as typeof fetch;
const dirs = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "watch-"));
  return { snapshots: path.join(root, "snapshots"), drafts: path.join(root, "drafts") };
};

describe("page watchers (C-01)", () => {
  it("keeps only the visible text, one line per block", () => {
    expect(pageText("<script>x()</script><h1>Title</h1><p>One &amp; two</p><div>  three  </div>")).toBe("Title\nOne & two\nthree");
  });

  it("a 404 opens an issue, not a draft, and keeps the snapshot", async () => {
    const d = dirs();
    await runWatch([source()], d, { fetch: serve(200, page()) });
    const before = readFileSync(path.join(d.snapshots, "acme-changelog.txt"), "utf8");
    const run = await runWatch([source()], d, { fetch: serve(404, "Not found") });
    expect(run.results).toEqual([{ id: "acme-changelog", url: "https://docs.acme.test/changelog", outcome: "failed", reason: "HTTP 404" }]);
    expect(run.issues).toHaveLength(1);
    expect(run.issues[0]).toMatchObject({ source: "acme-changelog", title: "Watcher: acme-changelog could not be checked" });
    expect(run.issues[0]!.body).toContain("No draft was written");
    expect(run.drafts).toEqual([]);
    expect(existsSync(d.drafts)).toBe(false);
    expect(readFileSync(path.join(d.snapshots, "acme-changelog.txt"), "utf8")).toBe(before);
  });

  it("rejects redirects, pages too small or too large, and pages missing a marker", async () => {
    const reason = async (src: WatchSource, f: typeof fetch) => (await checkSource(src, undefined, { fetch: f })).result.reason;
    expect(await reason(source(), serve(302, "", { location: "/login" }))).toBe("redirected (302) to /login");
    expect(await reason(source(), serve(200, "<p>Changelog</p>"))).toMatch(/^16 bytes, under the 2000-byte minimum$/);
    expect(await reason(source({ maxBytes: 3000 }), serve(200, page()))).toMatch(/over the 3000-byte maximum$/);
    expect(await reason(source({ markers: ["Changelog", "Breaking"] }), serve(200, page()))).toBe('missing marker "Breaking"');
    expect(await reason(source(), (async () => Promise.reject(new Error("ECONNRESET"))) as typeof fetch)).toBe("fetch failed: ECONNRESET");
  });

  it("rejects a page that lost more than 40% of its text since the snapshot", async () => {
    const d = dirs();
    await runWatch([source()], d, { fetch: serve(200, page("", 100)) });
    const run = await runWatch([source()], d, { fetch: serve(200, page("", 50)) });
    expect(run.results[0]!.outcome).toBe("failed");
    expect(run.results[0]!.reason).toMatch(/^shrank by \d+% since the snapshot \(more than 40%\)$/);
    expect(run.drafts).toEqual([]);
    // A small trim is a real change.
    const trimmed = await runWatch([source()], d, { fetch: serve(200, page("", 85)) });
    expect(trimmed.results[0]!.outcome).toBe("changed");
  });

  it("first run snapshots, an identical page is unchanged, and a changed page gets a draft with what moved", async () => {
    const d = dirs();
    expect((await runWatch([source()], d, { fetch: serve(200, page()) })).results[0]!.outcome).toBe("first");
    // Scripts and styles don't count: only the visible text.
    expect((await runWatch([source()], d, { fetch: serve(200, page().replace("Date.now()", "1")) })).results[0]!.outcome).toBe("unchanged");
    const run = await runWatch([source()], d, { fetch: serve(200, page("<p>Removed the v1 endpoint.</p>")), now: new Date("2026-10-30T08:00:00Z") });
    expect(run.results[0]).toMatchObject({ outcome: "changed", added: ["Removed the v1 endpoint."], removed: [] });
    expect(run.drafts.map((f) => path.basename(f))).toEqual(["acme-changelog-20261030.md"]);
    const draft = readFileSync(run.drafts[0]!, "utf8");
    expect(draft).toContain("# acme: acme-changelog changed on 2026-10-30");
    expect(draft).toContain("- Removed the v1 endpoint.");
    expect(readFileSync(path.join(d.snapshots, "acme-changelog.txt"), "utf8")).toContain("Removed the v1 endpoint.");
  });

  it("one issue per failing source, and the others still run", async () => {
    const d = dirs();
    const byUrl = (async (url: string | URL | Request) => (String(url).includes("broken") ? new Response("gone", { status: 410 }) : new Response(page()))) as typeof fetch;
    const run = await runWatch([source({ id: "broken", url: "https://broken.test/x" }), source()], d, { fetch: byUrl });
    expect(run.results.map((r) => `${r.id} ${r.outcome}`)).toEqual(["broken failed", "acme-changelog first"]);
    expect(run.issues.map((i) => i.source)).toEqual(["broken"]);
    expect(readdirSync(d.snapshots)).toEqual(["acme-changelog.txt"]);
  });

  it("the bundled sources validate", () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories", "watch", "sources.json");
    const sources = WatchSourceSchema.array().parse(JSON.parse(readFileSync(file, "utf8")));
    expect(sources.length).toBeGreaterThanOrEqual(5);
    for (const s of sources) expect(existsSync(path.join(path.dirname(file), "snapshots", `${s.id}.txt`)), s.id).toBe(true);
  });
});
