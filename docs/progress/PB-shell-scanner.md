# Shell and GitHub Actions: curl and gh api call sites

## Why

After the helper fix, two of SHAPI's five remaining misses on APIBreak-Replay called GitHub's API from shell steps in GitHub Actions workflows:
- **refracta/df-translations:** `STATUS="$(curl -w "%{http_code}" -X POST "$API_URL/repos/$TARGET_REPO/…/dispatches")"`, then `[[ "$STATUS" != "204" ]]`.
- **kikujizo/ai-harness:** `HTTP_CODE="$(gh api --method POST "repos/${TARGET_REPO}/…/dispatches" -i | head -n 1 | awk …)"`, then `!= "204"`.

SHAPI didn't read shell at all, and the file walker skipped `.github/`.

## What changes

`packages/extractor/src/shell.ts` reads `curl` and `gh api` commands in `.sh`/`.bash` files and in the `run:` steps of `.github/workflows/*.yml`. It is line-based, with no shell parser.
- **Commands:** a command is read through its `\` continuations, up to an unquoted `|`, `;`, `&&`, `)` or redirection.
- **curl:** the method comes from `-X`/`--request`, or is POST when data is sent. Headers come from `-H`. `-f`/`--fail` means the script accepts any 2xx.
- **gh api:** the method comes from `--method`/`-X`, or is POST with `-f`/`-F`/`--input`. The host is always `api.github.com`, and gh exits non-zero on an error status, so it accepts any 2xx unless the script checks a status itself. `gh api graphql` is skipped.
- **URLs:** literal assignments in the script (`API_URL="https://api.github.com"`) and the workflow's `env:` values are substituted. Expressions become placeholders named for their last part (`${{ steps.guard.outputs.target_repo }}` → `{target_repo}`).
- **Status codes:** when the command's output is assigned to a variable and carries the status (`-w "%{http_code}"`, or `-i`), the 3-digit codes that variable is later compared with (`==`, `!=`, `=`, `-eq`, `-ne`) are what the call depends on.
- **Scope:** only calls to known API providers become call sites. Installers, artifacts and a project's own services are left out.

The matcher also reads a role-prefixed repository parameter (`{target_repo}`, `{source_repo}`) as `owner/name` after `/repos/`, as it already did for `{repo}` and `{repository}`.

## Verified

- New tests: the two workflows' patterns (curl with env and script variables, and gh api with `-i` and a step-output repository) are affected while only 204 is accepted, and exposed once 200 is too. Also covered:
  - gh api without a status check;
  - `.sh` scripts with `-eq`;
  - an inline `run:` command;
  - comments, `gh api graphql`, and installer downloads left out.
- The two benchmark evidence files at their base and fix commits, scanned with this build: refracta and kikujizo are affected at base and exposed at fix.
- All extractor tests pass (95).
- shapi-cli is 0.3.4; the benchmark's numbers come from this PR's CI run.
