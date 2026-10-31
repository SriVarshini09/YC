import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories } from "@shapi/core";
import { extractCallSites, loadPythonParser } from "@shapi/extractor";

// A Graph API version pinned in config and used in a URL elsewhere: most of SHAPI 0.3.5's misses on APIBreak-Replay
// v1's Meta cases.
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
beforeAll(async () => loadPythonParser());

function scan(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-pins-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    const r = extractCallSites(dir);
    return { ...r, match: matchAdvisories(createApiLock(r, "t"), advisories, { now: new Date("2026-10-31T12:00:00Z") }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const meta = (r: ReturnType<typeof scan>) => r.callSites.filter((s) => s.provider === "meta-graph").map((s) => `${s.file} ${s.endpoint}`);

describe("API versions pinned in config", () => {
  it("fills {GRAPH_API_VERSION} from a Python settings default read with os.getenv", () => {
    const r = scan({
      "app/settings.py": 'import os\nGRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v21.0").strip()\n',
      "app/post.py": 'import requests\nfrom app import settings\ndef publish(page, token):\n    return requests.post(f"https://graph.facebook.com/{settings.GRAPH_API_VERSION}/{page}/feed", data={"access_token": token})\n',
    });
    expect(meta(r)).toEqual(["app/post.py /v21.0/{page}/feed"]);
    expect(r.match.affected.map((f) => f.advisory.id)).toContain("meta-graph-v21-sunset");
  });

  it("fills a TypeScript camelCase name from an env-var default, and from .env.example", () => {
    const r = scan({
      "src/config/env.ts": 'export const config = { graphApiVersion: process.env.GRAPH_API_VERSION?.trim() || "v20.0" };\n',
      "src/meta.ts": 'import { config } from "./config/env";\nexport const send = (id: string) => fetch(`https://graph.facebook.com/${config.graphApiVersion}/${id}/messages`, { method: "POST" });\n',
    });
    expect(meta(r)).toEqual(["src/meta.ts /v20.0/{id}/messages"]);
    const viaEnv = scan({
      ".env.example": "WHATSAPP_API_VERSION=v21.0\nWHATSAPP_TOKEN=\n",
      "src/wa.ts": 'const v = process.env.WHATSAPP_API_VERSION;\nexport const send = (id: string) => fetch(`https://graph.facebook.com/${v}/${id}/messages`, { method: "POST" });\n',
    });
    // `v` is not a version name; the env var's own name is not in the URL either: nothing to fill.
    expect(meta(viaEnv)).toEqual(["src/wa.ts /{v}/{id}/messages"]);
  });

  it("fills from .env.example when the URL names the variable", () => {
    const r = scan({
      ".env.example": "# Meta\nWHATSAPP_API_VERSION=v21.0\n",
      "src/wa.ts": 'const { WHATSAPP_API_VERSION } = process.env;\nexport const send = (id: string) => fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${id}/messages`, { method: "POST" });\n',
    });
    expect(meta(r)).toEqual(["src/wa.ts /v21.0/{id}/messages"]);
  });

  it("leaves the placeholder when the repository pins the name to more than one version, or to none", () => {
    const two = scan({
      "a.py": 'GRAPH_VERSION = "v21.0"\n',
      "c.py": 'GRAPH_VERSION = "v23.0"\n',
      "b.py": 'import requests\nfrom config import GRAPH_VERSION\ndef f(p):\n    requests.get(f"https://graph.facebook.com/{GRAPH_VERSION}/{p}")\n',
    });
    expect(meta(two)).toEqual(["b.py /{GRAPH_VERSION}/{p}"]);
    const none = scan({ "b.py": 'import os, requests\nGRAPH_VERSION = os.environ["GRAPH_VERSION"]\ndef f(p):\n    requests.get(f"https://graph.facebook.com/{GRAPH_VERSION}/{p}")\n' });
    expect(meta(none)).toEqual(["b.py /{GRAPH_VERSION}/{p}"]);
  });
});
