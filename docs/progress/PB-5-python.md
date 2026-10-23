# PB-5 Python scanning

What exists: SHAPI scans Python. It finds call sites and their dependency surface, which go into the same api.lock and are matched against the same advisories as TypeScript. It's scan only: fixes stay TypeScript/JavaScript, and a Python call site is reported as "scanned only" in the fix flow.

**Parser:** tree-sitter, through `web-tree-sitter` 0.27.1 (WASM, MIT) and the `tree-sitter-python` 0.25.0 grammar (MIT). Nothing is compiled natively.
- `loadPythonParser()` loads it once. The CLI, the MCP server and the hosted scan job call it, and until it has loaded, Python files are listed as "not scanned".
- The published `shapi-cli` ships the grammar's `.wasm` inside the package rather than depending on `tree-sitter-python`. That package's install script would build a native binding the scanner never uses. The package gains one dependency, `web-tree-sitter`.

**What it finds:**
- **HTTP:** `requests` (module functions and `Session`, also on `self.http`), `httpx` (functions, and `Client`/`AsyncClient` with `base_url` and `headers`), `aiohttp` (`ClientSession`, including `async with session.get(...) as resp`), and `.request("GET", url)`.
- **URLs:** strings, f-strings (`{owner}` placeholders, `quote(x)` → `{x}`), module constants, `+` concatenation and `os.getenv("X", "https://…")` defaults. `params=` and `headers=` dicts (or `dict(...)`) are read as query parameters and headers.
- **SDKs:** OpenAI, Anthropic, Stripe (module style `stripe.checkout.Session.retrieve` and `StripeClient`), Slack `WebClient` (`chat_postMessage` → `POST /api/chat.postMessage`), Twilio and HubSpot. The method maps are in the provider registry under `python`.
- **Surface:**
  - from the response: `status_code`/`status` compared with `==`, `!=` or `in (…)`; `ok`; `raise_for_status()`; `headers[...]` and `headers.get(...)`;
  - body fields from `.json()` and from SDK objects: `["key"]`, `.get("key")`, attribute access, list items through `for` loops and comprehensions (`results[].stages[].stageId`), and `x = data["results"]`;
  - string comparisons as enum values.
- **Declared SDKs:** `requirements*.txt` and `pyproject.toml` (PEP 621 lists and Poetry tables).

Verified:
- **A Python fixture** covers every client and SDK above, and its tests check each call site's endpoint and surface.
- **Real advisories match Python call sites:** GitHub 204 → 200, QuickBooks minorversion, HubSpot pipelines v1, Meta Graph v21.0, Stripe `ui_mode` and Slack `files.upload`.
- **The npm package works:** the packed `shapi-cli`, installed into an empty folder, scans the Python fixture with the bundled grammar.
- 250 tests pass, plus lint and typecheck.

Not done yet: publishing a new `shapi-cli` version with Python support. 0.1.0 on npm is TypeScript only.
