import { PYTHON_GENERATED_TEST_HEADER, type Advisory, type LockedCallSite } from "@shapi/core";
import { parsePython, type PyNode } from "@shapi/extractor";
import { BREAKAGE, CONTRACT_DIR, UNTESTABLE, type ContractTest } from "../contract";


/**
 * A contract test for a Python call site (execution plan U-03), with the standard library only: a unittest test that
 * pytest also runs, and that prints vitest's summary line when run as a script, so SHAPI reads its result the same way.
 * It imports the module, sets the environment variables the function reads, and calls the function with placeholder
 * arguments while urllib, requests and httpx are stubbed: every request is recorded, none leaves the machine, and each
 * answers with a JSON object holding every key the function reads.
 * - `request` (the advisory's fix changes what is sent): the test fails if the function sends the retired request.
 * - `recorded` (the response changed, a status code): the function runs against the old and the new status and must
 *   return the same result for both, without an error.
 * The function must actually call the endpoint: if it returns first, the test says it cannot test the call.
 */
export function generatePythonContractTest(input: { callSite: LockedCallSite; advisory: Advisory; sourceText: string; file?: string }): ContractTest {
  const { callSite, advisory } = input;
  const fix = advisory.fix;
  const statuses = advisory.trigger.statusCodes ?? [];
  const newStatuses = advisory.trigger.newStatusCodes ?? [];
  const kind = fix && (fix.path || fix.query || fix.header) ? "request" : statuses.length && newStatuses.length ? "recorded" : undefined;
  if (!kind) return { status: "unsupported", reason: "Python contract tests cover a changed request (path, query, header) or a changed status code" };

  const tree = parsePython(input.sourceText);
  if (!tree) return { status: "unsupported", reason: `${callSite.file} does not parse` };
  try {
    const at = tree.rootNode.descendantForPosition({ row: callSite.line - 1, column: callSite.column - 1 });
    let fn: PyNode | null = at;
    while (fn && fn.type !== "function_definition") fn = fn.parent;
    if (!fn) return { status: "unsupported", reason: "the call is not inside a function, so there is nothing to call" };
    const owner = fn.parent?.type === "decorated_definition" ? fn.parent.parent : fn.parent;
    if (owner?.type !== "module") return { status: "unsupported", reason: "SHAPI tests module-level Python functions; this call is in a method or a nested function" };
    if (fn.children.some((c) => c?.type === "async")) return { status: "unsupported", reason: "SHAPI does not test async Python functions yet" };
    const name = fn.childForFieldName("name")?.text;
    if (!name) return { status: "unsupported", reason: "the function has no name" };
    const params = fn.childForFieldName("parameters")?.namedChildren.filter((p): p is PyNode => p !== null) ?? [];
    // Required parameters get a placeholder; ones with defaults, *args and **kwargs are left out.
    const required = params.filter((p) => p.type === "identifier" || p.type === "typed_parameter").map((p) => (p.type === "identifier" ? p.text : p.namedChildren[0]?.text));
    if (required.some((p) => p === undefined)) return { status: "unsupported", reason: "a parameter SHAPI cannot read" };

    const strings = (n: PyNode | null | undefined) => (n?.type === "string" ? n.namedChildren.filter((c) => c?.type === "string_content").map((c) => c!.text).join("") : undefined);
    const env = new Set<string>();
    const keys = new Set<string>();
    for (const call of fn.descendantsOfType("call")) {
      const callee = call?.childForFieldName("function")?.text ?? "";
      const first = strings(call?.childForFieldName("arguments")?.namedChildren[0]);
      if (first === undefined) continue;
      if (/(^|\.)(environ\.get|getenv)$/.test(callee)) env.add(first);
      else if (callee.endsWith(".get")) keys.add(first);
    }
    for (const sub of fn.descendantsOfType("subscript")) {
      const key = strings(sub?.childForFieldName("subscript"));
      if (key === undefined) continue;
      if (/(^|\.)environ$/.test(sub?.childForFieldName("value")?.text ?? "")) env.add(key);
      else keys.add(key);
    }

    const config = {
      advisory: advisory.id,
      module: callSite.file,
      function: name,
      args: required.length,
      env: [...env].sort(),
      keys: [...keys].sort(),
      endpoint: endpointRegex(advisory.endpoint.path),
      kind,
      ...(kind === "request"
        ? {
            path: fix!.path ? fix!.path.from : null,
            query: fix!.query ? { name: fix!.query.name, value: fix!.query.value, below: advisory.trigger.query?.find((q) => q.name === fix!.query!.name)?.below ?? null } : null,
            header: fix!.header ? { name: fix!.header.name, value: fix!.header.value, values: advisory.trigger.headers?.find((h) => h.name.toLowerCase() === fix!.header!.name.toLowerCase())?.values ?? null } : null,
          }
        : { before: statuses[0], after: newStatuses.find((s) => !statuses.includes(s)) ?? newStatuses[0] }),
    };
    const file = input.file ?? `${CONTRACT_DIR}/test_${advisory.id.replace(/[^a-zA-Z0-9]/g, "_")}.py`;
    return { status: "generated", file, content: pythonTest(config, file), functionName: name, kind };
  } finally {
    tree.delete();
  }
}

function pythonTest(config: Record<string, unknown>, file: string): string {
  const depth = file.split("/").length - 1;
  return `${PYTHON_GENERATED_TEST_HEADER}${String(config.advisory)}: ${String(config.function)}() in ${String(config.module)}.
# It stubs urllib, requests and httpx, so nothing leaves the machine. Run it with pytest, or as a script.
import importlib.util
import io
import json
import os
import re
import sys
import unittest
import urllib.parse
import urllib.request
from unittest import mock

CONFIG = json.loads(${JSON.stringify(JSON.stringify(config))})
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ${JSON.stringify(Array(depth).fill("..").join("/") || ".")}))
BREAKAGE = ${JSON.stringify(BREAKAGE)}
UNTESTABLE = ${JSON.stringify(UNTESTABLE)}
BODY = json.dumps({key: "shapi-test" for key in CONFIG["keys"]}).encode()


class Sent:
    def __init__(self, method, url, params=None, headers=None):
        parts = urllib.parse.urlsplit(str(url))
        self.method = (method or "GET").upper()
        self.url = str(url)
        self.path = parts.path
        self.query = dict(urllib.parse.parse_qsl(parts.query))
        for key, value in dict(params or {}).items():
            self.query[str(key)] = str(value)
        self.headers = {str(k).lower(): str(v) for k, v in dict(headers or {}).items()}

    def retired(self):
        """Why this request is the one the provider retired, or None."""
        if CONFIG.get("path") and CONFIG["path"] in self.path:
            return "its path has " + CONFIG["path"]
        query = CONFIG.get("query")
        if query and query["name"] in self.query:
            value = self.query[query["name"]]
            numeric = re.fullmatch(r"\\d+(\\.\\d+)?", value) is not None
            if query["below"] is not None and numeric and float(value) < query["below"]:
                return "%s=%s, below %s" % (query["name"], value, query["below"])
            if query["below"] is None and value != query["value"]:
                return "%s=%s, not %s" % (query["name"], value, query["value"])
        header = CONFIG.get("header")
        if header and header["name"].lower() in self.headers:
            value = self.headers[header["name"].lower()]
            if value != header["value"] and (header["values"] is None or value in header["values"]):
                return "%s: %s" % (header["name"], value)
        return None


class Stubs:
    """urllib, requests and httpx answer every request from here, with this status."""

    def __init__(self, status):
        self.status = status
        self.sent = []

    def answer(self, method, url, params=None, headers=None):
        self.sent.append(Sent(method, url, params, headers))
        return self.status

    def __enter__(self):
        stubs = self
        self.patches = []

        class UrllibResponse(io.BytesIO):
            def __init__(self, status, url):
                super().__init__(BODY)
                self.status = status
                self.code = status
                self.url = url
                self.headers = {"Content-Type": "application/json"}

            def getcode(self):
                return self.status

            def info(self):
                return self.headers

        def urlopen(req, *args, **kwargs):
            if isinstance(req, urllib.request.Request):
                status = stubs.answer(req.get_method(), req.full_url, None, dict(req.header_items()))
                return UrllibResponse(status, req.full_url)
            status = stubs.answer("POST" if kwargs.get("data") or (args and args[0]) else "GET", req)
            return UrllibResponse(status, str(req))

        self.patches.append(mock.patch("urllib.request.urlopen", urlopen))

        class HttpResponse:
            def __init__(self, status, url):
                self.status_code = status
                self.status = status
                self.ok = 200 <= status < 400
                self.is_success = 200 <= status < 300
                self.url = url
                self.content = BODY
                self.text = BODY.decode()
                self.headers = {"content-type": "application/json"}

            def json(self, **kwargs):
                return json.loads(BODY)

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise RuntimeError("HTTP %d" % self.status_code)
                return self

        try:
            import requests  # noqa: F401

            def session_request(session, method, url, params=None, headers=None, **kwargs):
                return HttpResponse(stubs.answer(method, url, params, {**dict(getattr(session, "headers", {}) or {}), **dict(headers or {})}), url)

            self.patches.append(mock.patch("requests.sessions.Session.request", session_request))
        except ImportError:
            pass
        try:
            import httpx  # noqa: F401

            def client_request(client, method, url, *args, params=None, headers=None, **kwargs):
                return HttpResponse(stubs.answer(method, str(client.base_url.join(url)) if getattr(client, "base_url", None) else url, params, headers), str(url))

            self.patches.append(mock.patch("httpx.Client.request", client_request))
        except ImportError:
            pass
        for p in self.patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in reversed(self.patches):
            p.stop()


def run(status):
    """Call the function once with every request answered with \`status\`: (what it sent, its result, its error)."""
    for path in (ROOT, os.path.dirname(os.path.join(ROOT, CONFIG["module"]))):
        if path not in sys.path:
            sys.path.insert(0, path)
    with mock.patch.dict(os.environ, {name: "shapi-test" for name in CONFIG["env"]}), Stubs(status) as stubs:
        spec = importlib.util.spec_from_file_location("shapi_contract_target", os.path.join(ROOT, CONFIG["module"]))
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as error:  # noqa: BLE001
            raise AssertionError("%s: %s does not import here: %r" % (UNTESTABLE, CONFIG["module"], error))
        result, error = None, None
        try:
            result = getattr(module, CONFIG["function"])(*(["shapi-test"] * CONFIG["args"]))
        except Exception as e:  # noqa: BLE001
            error = e
    endpoint = re.compile(CONFIG["endpoint"])
    calls = [s for s in stubs.sent if endpoint.search(s.path)]
    if not calls:
        raise AssertionError("%s: %s() did not call the endpoint with placeholder arguments (%s)" % (UNTESTABLE, CONFIG["function"], repr(error) if error else "it returned " + repr(result)))
    return calls, result, error


class ShapiContract(unittest.TestCase):
    def test_contract(self):
        if CONFIG["kind"] == "request":
            calls, _, _ = run(200)
            for sent in calls:
                why = sent.retired()
                if why:
                    raise AssertionError("%s: %s() sends the retired request %s %s (%s)" % (BREAKAGE, CONFIG["function"], sent.method, sent.url, why))
        else:
            _, before, before_error = run(CONFIG["before"])
            _, after, after_error = run(CONFIG["after"])
            if before_error is None and after_error is not None:
                raise AssertionError("%s: %s() fails when the API answers %s instead of %s: %r" % (BREAKAGE, CONFIG["function"], CONFIG["after"], CONFIG["before"], after_error))
            if before_error is None and before != after:
                raise AssertionError("%s: %s() returns %r when the API answers %s, but %r for %s" % (BREAKAGE, CONFIG["function"], after, CONFIG["after"], before, CONFIG["before"]))


if __name__ == "__main__":
    outcome = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ShapiContract))
    for _, trace in outcome.failures + outcome.errors:
        print(trace.strip().splitlines()[-1])
    failed = len(outcome.failures) + len(outcome.errors)
    print(" Tests  %s (%d)" % ("%d failed" % failed if failed else "%d passed" % outcome.testsRun, outcome.testsRun))
    sys.exit(1 if failed else 0)
`;
}

/**
 * An advisory's path pattern as a regular expression for the paths a request really has (Python's `re` reads it too):
 * a parameter is one segment, `*` part of one, `**` any number. Searched, so a base path before it still matches.
 */
export function endpointRegex(pattern: string): string {
  let re = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("/**", i)) {
      re += "(?:/.*)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else if (pattern[i] === "{") {
      const end = pattern.indexOf("}", i);
      re += "[^/]+";
      i = end < 0 ? pattern.length : end + 1;
    } else {
      re += pattern[i]!.replace(/[.+?^$()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return `${re}/?$`;
}
