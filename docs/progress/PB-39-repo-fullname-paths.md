# PB-39: A `{repo}` path parameter holding `owner/name` matches GitHub advisories

## Why

APIBreak-Replay's first miss was vincentng295/gemini_fbchat. The code builds `api_base = f"https://api.github.com/repos/{repo}"` with `repo = "owner/name"`. It then posts to `f"{api_base}/actions/workflows/{workflow_id}/dispatches"` and checks `status_code == 204`.

SHAPI mapped the call as `POST /repos/{repo}/actions/workflows/{workflow_id}/dispatches`. That has one segment where the advisory's pattern has two, `{owner}/{repo}`, so the matcher missed it.

## What changes

- **`pathMatches`** (`packages/core/src/matcher.ts`): when a path doesn't match, it tries once more with a full-name parameter right after `/repos/` read as `{owner}/{name}`.
  - Full-name parameters: `{repo}`, `{repository}`, `{full_name}`, `{repo_slug}`, `{github.repository}`, `{nwo}`, `{owner_repo}` and similar names.
  - Other names, and the same names anywhere else in a path, still fill one segment.

## Verified

- **New test** in `packages/core/test/matcher.test.ts`: four full-name spellings match the dispatch advisory, while `{id}`, a path not under `/repos/`, and a different endpoint don't.
- **APIBreak-Replay on dataset `37fa931e8278`:**
  - flag recall 4/14 → **5/14**, and 4/10 → **5/10** in scanned files;
  - fixed-state precision unchanged at 13/14;
  - gemini_fbchat is `affected` before its fix and `exposed` after it.
- **Full suite:** typecheck and lint are clean, and the full suite passes.
