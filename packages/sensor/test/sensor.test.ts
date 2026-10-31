import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getProvider, loadAdvisories } from "@shapi/core";
import { createSensor, installSensor, matchEndpoint, patternRegex, SENSOR_ENDPOINTS, sensorShape } from "../src/index";

// Execution plan F-01: the traffic add-on for Node and Python.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");

const BODIES = [
  "",
  "not json",
  JSON.stringify({ id: 1, name: "x", price: 1.5, ok: true, gone: null, tags: ["a"], items: [{ id: 2, sub: { k: "v" } }, { id: 3, extra: [] }], "a.b": 1, "x[y": { "z\\w": 2 } }),
  JSON.stringify([{ id: 1 }, { id: "two" }]),
  JSON.stringify(42),
];

describe("traffic sensor (F-01)", () => {
  it("records only endpoints SHAPI's advisories name, under the pattern, never the request's own path", () => {
    expect(matchEndpoint("POST", new URL("https://api.github.com/repos/acme/app/actions/workflows/ci.yml/dispatches"))?.path).toBe("/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches");
    expect(matchEndpoint("GET", new URL("https://api.github.com/repos/acme/app/actions/workflows/ci.yml/dispatches"))).toBeUndefined();
    expect(matchEndpoint("GET", new URL("https://example.com/repos/a/b/actions/workflows/c/dispatches"))).toBeUndefined();
    expect(matchEndpoint("POST", new URL("https://api.anthropic.com/v1/messages"))?.provider).toBe("anthropic");
    expect(new RegExp(patternRegex("/v22/**")).test("/v22/customers/1/googleAds:search")).toBe(true);
    expect(new RegExp(patternRegex("/*/models/{?}:*")).test("/v1beta/models/gemini-2.0-flash:generateContent")).toBe(true);
  });

  it("keeps the endpoint list in step with the advisories (pnpm --filter @shapi/sensor endpoints)", () => {
    const expected = new Set(loadAdvisories(path.join(root, "advisories")).filter((a) => a.endpoint.hosts ?? getProvider(a.provider)?.hosts).map((a) => `${a.provider} ${a.endpoint.method} ${a.endpoint.path}`));
    expect(new Set(SENSOR_ENDPOINTS.map((e) => `${e.provider} ${e.method} ${e.path}`))).toEqual(expected);
    expect(readFileSync(path.join(here, "..", "python", "shapi_sensor", "endpoints.json"), "utf8")).toBe(readFileSync(path.join(here, "..", "src", "endpoints.json"), "utf8"));
  });

  it("records field names and types only: no values", () => {
    const shape = sensorShape(200, [["Content-Type", "application/json"], ["Sunset", "Wed, 11 Nov 2026 23:59:59 GMT"], ["Set-Cookie", "s=1"]], BODIES[2]!);
    expect(shape.headers).toEqual({ sunset: "Wed, 11 Nov 2026 23:59:59 GMT" });
    expect(shape.body.fields.map((f) => `${f.path}:${f.types.join("|")}`)).toEqual([
      "a\\.b:integer", "gone:null", "id:integer", "items:array", "items[]:object", "items[].extra:array", "items[].id:integer", "items[].sub:object", "items[].sub.k:string",
      "name:string", "ok:boolean", "price:number", "tags:array", "tags[]:string", "x\\[y:object", "x\\[y.z\\\\w:integer",
    ]);
    expect(JSON.stringify(shape)).not.toMatch(/"x"|1\.5|"v"|"a"]/);
  });

  it("prints exactly what it would send in dry-run mode, and sends nothing", async () => {
    const lines: string[] = [];
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "hi" }] }), { status: 200, headers: { "anthropic-version": "2023-06-01" } });
    }) as typeof globalThis.fetch;
    const original = globalThis.fetch;
    const sensor = installSensor({ dryRun: true, fetch, log: (l) => lines.push(l) });
    try {
      const res = await globalThis.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
      expect(await res.json()).toMatchObject({ id: "msg_1" }); // the caller's response is untouched
      await globalThis.fetch("https://internal.example.com/health");
    } finally {
      await sensor.stop();
    }
    expect(globalThis.fetch).toBe(original);
    expect(calls).toEqual(["https://api.anthropic.com/v1/messages", "https://internal.example.com/health"]);
    expect(lines).toHaveLength(1);
    const batch = JSON.parse(lines[0]!.replace(/^\[shapi-sensor\] dry run, would send: /, ""));
    expect(batch).toMatchObject({ v: 1, sdk: "node", observations: [{ provider: "anthropic", method: "POST", endpoint: "/v1/messages", count: 1 }] });
    expect(batch.observations[0].shape.body.fields.map((f: { path: string }) => f.path)).toEqual(["content", "content[]", "content[].text", "content[].type", "id"]);
    expect(lines[0]).not.toMatch(/msg_1|hi"/);
  });

  it("needs a token unless it is a dry run", () => {
    expect(() => createSensor({})).toThrow(/token/);
  });

  it("the Python sensor writes the same shapes and matches the same endpoints", () => {
    const py = process.platform === "win32" ? "python" : "python3";
    const script = [
      "import json, sys",
      "sys.path.insert(0, sys.argv[1])",
      "import shapi_sensor as s",
      "bodies = json.loads(sys.stdin.read())",
      "shapes = [s.sensor_shape(200, [('Sunset', 'x'), ('Content-Type', 'application/json')], b) for b in bodies]",
      "m = s.match_endpoint('POST', 'https://api.github.com/repos/acme/app/actions/workflows/ci.yml/dispatches')",
      "print(json.dumps({'shapes': shapes, 'match': m['path'] if m else None, 'none': s.match_endpoint('GET', 'https://example.com/x')}))",
    ].join("\n");
    const run = spawnSync(py, ["-I", "-c", script, path.join(here, "..", "python")], { input: JSON.stringify(BODIES), encoding: "utf8" });
    if (run.error) return expect.soft(run.error.message).toBe("Python is available"); // CI and dev machines have it
    expect(run.stderr).toBe("");
    const out = JSON.parse(run.stdout);
    expect(out.shapes).toEqual(BODIES.map((b) => sensorShape(200, [["Sunset", "x"], ["Content-Type", "application/json"]], b)));
    expect(out.match).toBe("/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches");
    expect(out.none).toBeNull();
  });
});
