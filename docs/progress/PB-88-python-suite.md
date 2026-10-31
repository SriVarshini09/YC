# PB-88: Python dependencies from PyPI, and the repository's own pytest suite (PASS_TO_PASS for Python)

## Why

U-03 shipped Python fixes without the repository's own tests (PASS_TO_PASS), because the sandbox reached only the npm registries and Python tests need their dependencies. On 2026-10-30 the founder approved PyPI during installs (the SC-02 T3 decision).

## What changes

- **`REGISTRY_HOSTS` adds `pypi.org` and `files.pythonhosted.org`.** They are reachable only while dependencies install, like npm; the network is off before any of the repository's code runs.
- **A Python project** (one with a `requirements.txt`, `pyproject.toml`, `setup.py` or `setup.cfg`) gets a virtualenv in `.shapi-venv`, then:
  - `pip install -r requirements.txt` (or `pip install -e .`);
  - any `requirements-dev.txt` or `requirements-test.txt`;
  - `pytest`.

  A failed Python install is reported in the install report, not fatal. A contract test that needs only the standard library still runs.
- **Python contract tests run with the virtualenv's Python.**
- **The repository's own suite:** when the repository has no npm test script, SHAPI runs `pytest -q -rfE --color=no` with its contract tests left out, before and after the fix. A test that passed before and fails after rejects the fix, as for TypeScript (V-01). If pytest collects no tests, there is no suite.
- **Parsing:** `suiteCounts` and `failingTests` read pytest's summary (warnings left out) and its `FAILED`/`ERROR` lines. They strip ANSI colors first, because pytest colors its output whenever `FORCE_COLOR` is set, even to `0`; that hid the counts in the first real run.
- **SHAPI's E2B template (`shapi-node22`) now installs `python3-venv` and `python3-pip`.** The Node 22 image has `python3` but not the venv module. The template was rebuilt in the E2B account (38 s).
- **Docs:** the sandbox threat model (install step, T3) and "How fixes are verified" say so.

## Result

**The benchmark's QuickBooks Python instance, `hfscdogg/outgrow`, in E2B:**
- `pip install -e .` installed its dependencies from PyPI;
- the recipe fixed `scripts/smoke_creds.py:129`;
- the repository's own suite ran before and after: **458 passed → 458 passed**.

## Verified

- **Recording-sandbox tests:**
  - the install order, with the network on only during install;
  - `requirements.txt` and `requirements-dev.txt`;
  - `pip install -e .` for a pyproject project, with a failed install kept as a report;
  - the venv's Python for contract tests, and pytest for the suite;
  - pytest's "no tests" (exit 5) meaning no suite.
- **Parsing:** pytest counts and failing-test names, plain and colored.
- **`checkSuite`** rejects a fix that makes a passing pytest test fail, and ignores a test that already failed.
- **The real E2B run** above.
