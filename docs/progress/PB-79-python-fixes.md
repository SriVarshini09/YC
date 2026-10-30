# PB-79: Python fixes with the two deterministic recipes (execution plan U-03)

## Why

SHAPI has scanned Python for a while but only fixed TypeScript and JavaScript. In the P-02 fix run, the QuickBooks Python instance (`hfscdogg/outgrow`) was "unsupported: fixes support TypeScript and JavaScript".

## What changes

- **Python recipes** (`packages/repair/src/python/recipes.ts`) on tree-sitter's syntax tree.
  - **`apply-fix`** rewrites the URL a call sends: a string, an f-string, an implicit or `+` concatenation, or a name assigned one in the same function or module. It also rewrites the `params=` and `headers=` dicts. As in TypeScript, a threshold such as "minorversion below 75" leaves values at or above it alone.
  - **`status-code-accept-set`** turns `resp.status_code != 204` into `resp.status_code not in (200, 204)` and widens a `(…)`, `[…]` or `{…}` of codes. It acts only on the response the call returned (`resp = requests.post(…)`, `with urlopen(…) as resp`).
  - The call site can be a call (requests, httpx, an SDK) or a bare URL string (urllib).
  - Renamed response fields and enum values are not rewritten in Python yet.
- **Python contract test** (`test/shapi/test_<advisory>.py`), standard library only, so pytest runs it and so does `python <file>`.
  - It imports the module, sets the environment variables the function reads to placeholders, and calls the function with `urllib`, `requests` and `httpx` stubbed. Each request is answered with a JSON object holding every key the function reads, and nothing leaves the machine.
  - **Changed request:** the test fails if the function sent the retired request. It checks what was sent rather than an exception, so it works when the code catches every error, as the benchmark's code does.
  - **Changed status:** the same result and no error for the old and the new status.
  - If the function returns before calling the endpoint, the result is "SHAPI cannot test this", not a fix.
  - It prints vitest's summary and marker lines, so the existing gates read its result unchanged.
- **The repair flow is the same:**
  - the baseline must fail as a breakage;
  - the recipe must make the test pass;
  - undoing each part must fail the test again (V-04);
  - the scope check applies (V-05).

  **Not done for Python yet, each stated in the result:** type-checking, the keep check (V-06), and Claude.
- **The repository's own Python tests are not run (PASS_TO_PASS)**, and the result says why. They need the repository's dependencies from PyPI, and the sandbox reaches only the npm registry. Opening PyPI would widen the install step that the sandbox threat model's top finding (T3) is about, so that's the founder's decision.
- **Runners:** `.py` contract tests run with Python, locally (`SHAPI_PYTHON`, else `python`/`python3`) and in the sandbox (`python3`; the Node 22 template image has it).
- **SHAPI's generated Python tests are skipped by scans** (`PYTHON_GENERATED_TEST_HEADER`), like the TypeScript ones.
- **The GitHub App worker now loads the Python grammar.** Before, the App skipped Python files entirely; now it scans them, and fix jobs repair Python call sites. If the grammar fails to load, Python files are skipped as before.
- **Docs:** "How fixes are verified" has a Python section. How it works, the quickstart, the FAQ and the README say what Python fixes cover.

## Result

**The benchmark's QuickBooks Python instance is fixed in E2B by the recipe:**

```
quickbooks-minorversion-below-75__hfscdogg__outgrow  shapi fix fixed: scripts/smoke_creds.py:129 fixed via recipe
```

It is a recipe-only run with no Claude calls. The stored benchmark results were left as they were.

## Verified

- **Recipe tests (on call sites from the real extractor and the real advisories):**
  - an f-string concatenation sent with urllib;
  - a `params=` dict, and a URL built from a module constant;
  - 75 and above left alone;
  - status comparisons on the call's own response only, with `in (…)` widened;
  - no change when the code already accepts the new code;
  - generated Python tests are not scanned.
- **End-to-end repair tests (real Python, local workspace):**
  - the benchmark-shaped QuickBooks function (credentials from the environment, a token refresh, an exception catch-all): the baseline fails with "sends the retired request … minorversion=65", the recipe fixes it, and undo passes;
  - a GitHub dispatch status check with requests (skipped where requests isn't installed);
  - a function that returns before the call is reported as untestable.
