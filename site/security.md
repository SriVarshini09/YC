# Security and code handling

SHAPI reads your code in order to fix it. This page says exactly what that involves.

## The CLI

`shapi scan` and `shapi fix` run on your machine. `scan` parses your files and runs nothing. `fix` runs a generated contract test against a temporary copy of your repository, deleted when the run ends, with none of your environment's tokens or keys. Nothing is uploaded, except:

- **With `--pr`:** the changed files go to GitHub, through your own token.
- **With `--llm`:** the affected file, the advisory, the contract test and its failing output go to Anthropic's API, through your own key.

## The hosted GitHub App

### Your code

- **Read with a narrow, short-lived token.** To scan or fix a commit, SHAPI creates an installation token limited to **that one repository with read-only contents**. It expires within an hour, and it's the only credential used to download code.
- **Not stored.** The commit is downloaded into memory and analyzed in a temporary folder that is deleted when the job ends. SHAPI keeps the **api.lock** (which third-party endpoints are called, from which file and line, and what the code depends on in the response), the findings, and for each fix it proposes the diff and the contract-test output shown in the web app. Your source files are not kept.
- **Never run outside a sandbox.** Installing dependencies and running tests happen only inside a fresh **E2B Firecracker microVM** for each job:
  - Only the npm and Yarn registries are reachable during the install.
  - **The network is limited to the package registries** during the dependency install, where install scripts run, and **switched off entirely** before your code or tests run.
  - The VM contains no tokens or SHAPI credentials.
  - It is destroyed after the job. It starts with a 15-minute lifetime, extended while the job works, and never lives past 60 minutes.

### What SHAPI stores

| Data | Why | How long |
|---|---|---|
| Account login, installation id, your settings | To run the app for your account | While installed |
| Repository names, default branch, public or private | To scan the right repositories | While installed |
| api.lock and findings per scanned commit | To show results and re-check on new advisories | While installed |
| Fix PR records, including each fix's diff and contract-test output | Noise limits and the dashboard | While installed |
| GitHub webhook payloads | Processing and retries | 14 days after processing |
| Web sessions (a SHA-256 of the session token only) | Sign-in | 8 hours |
| Stripe customer and subscription ids | Billing | While installed |

Uninstalling the GitHub App deletes the account and its repositories, scans, findings, fix PR records and billing record at once. Webhook payloads expire 14 days after they're processed. A paid subscription is managed in Stripe, and uninstalling cancels it there first, at once.

The [privacy policy](/legal/privacy) covers the same data in more detail, and the [subprocessors](/legal/subprocessors) page lists every outside service that receives any of it.

### Isolation between customers

Every account-scoped table in Postgres uses **row-level security** keyed to the account. The app's database role cannot bypass it, so a query that forgets a filter still sees only one customer's rows. On top of that, the web app checks what your GitHub user may do:

- **Seeing:** you see an account only where SHAPI is installed and you can open at least one of its repositories on GitHub. Inside it, every page shows only the repositories you can open on GitHub, with their problems, fixes and scans. Any other repository's pages are not found.
- **Pausing** a repository needs write access to it.
- **Settings and billing** (pull request limits, the check, Claude, Slack alerts, the plan and invoices) need an account admin. For a personal account, that is its owner. For an organization, it is someone who is admin on every repository SHAPI covers there; organization owners are.

SHAPI reads these rights from GitHub when you sign in. After a change on GitHub, sign in again to see it.

### Claude

Off by default, and the setting appears only when Claude is enabled on the server. When an account turns on *Use Claude when no deterministic recipe fits*, the affected file, the advisory, the contract test and its failing output are sent to Anthropic's API for that call site. The proposed change may touch only source files, and is kept only if the contract test passes in the sandbox and the code still type-checks. A fix job makes at most 20 Claude calls.

### Other safeguards

- **Webhooks:** GitHub's HMAC-SHA256 signature is verified on the raw body.
- **Sign-in:** SHAPI keeps no GitHub user token. The session cookie is HttpOnly, SameSite and signed.
- **Web pages:** they run no JavaScript, and a strict Content Security Policy is applied.
- **Canaries:** SHAPI probes provider APIs only with its own accounts, and stores response shapes (status codes, field names and types), never values.

## Reporting a vulnerability

Please report security issues privately by email to [sri@shapi.dev](mailto:sri@shapi.dev) with the subject "Security", not in a public issue.
