# Security and code handling

SHAPI reads your code in order to fix it. This page says exactly what that involves.

## The CLI

`shapi scan` and `shapi fix` run on your machine. `scan` parses your files and runs nothing. `fix` runs a generated contract test against a temporary copy of your repository. Nothing is uploaded, except:

- **With `--pr`:** the changed files go to GitHub, through your own token.
- **With `--llm`:** the affected file, the advisory and the contract test go to Anthropic's API, through your own key.

## The hosted GitHub App

### Your code

- **Read with a narrow, short-lived token.** To scan or fix a commit, SHAPI creates an installation token limited to **that one repository with read-only contents**. It expires within an hour, and it's the only credential used to download code.
- **Not stored.** The commit is downloaded into memory and analyzed in a temporary folder that is deleted when the job ends. SHAPI keeps the **api.lock** (which third-party endpoints are called, from which file and line, and what the code depends on in the response) and the findings. Your source files are not kept.
- **Never run outside a sandbox.** Installing dependencies and running tests happen only inside a fresh **E2B Firecracker microVM** for each job:
  - Only the npm and Yarn registries are reachable during the install.
  - **The network is switched off entirely** before any of your code or tests run.
  - The VM contains no tokens or SHAPI credentials.
  - It is destroyed after the job and lives at most 15 minutes.

### What SHAPI stores

| Data | Why | How long |
|---|---|---|
| Account login, installation id, your settings | To run the app for your account | While installed |
| Repository names, default branch, public or private | To scan the right repositories | While installed |
| api.lock and findings per scanned commit | To show results and re-check on new advisories | While installed |
| Fix PR records | Noise limits and the dashboard | While installed |
| GitHub webhook payloads | Processing and retries | 14 days |
| Web sessions (a SHA-256 of the session token only) | Sign-in | 8 hours |
| Stripe customer and subscription ids | Billing | While subscribed |

Uninstalling the GitHub App deletes the account and its repositories, scans, findings, fix PR records and billing record at once. Webhook payloads expire on their 14-day schedule. A paid subscription is managed in Stripe: cancel it under *Manage billing* before uninstalling.

The [privacy policy](/legal/privacy) covers the same data in more detail, and the [subprocessors](/legal/subprocessors) page lists every outside service that receives any of it.

### Isolation between customers

Every customer table in Postgres uses **row-level security** keyed to the account. The app's database role cannot bypass it, so a query that forgets a filter still sees only one customer's rows. The web app only opens accounts your GitHub user can access.

### Claude

Off by default, and the setting appears only when Claude is enabled on the server. When an account turns on *Use Claude when no deterministic recipe fits*, the affected file, the advisory and the contract test are sent to Anthropic's API for that call site. The proposed change is kept only if the contract test passes in the sandbox.

### Other safeguards

- **Webhooks:** GitHub's HMAC-SHA256 signature is verified on the raw body.
- **Sign-in:** SHAPI keeps no GitHub user token. The session cookie is HttpOnly, SameSite and signed.
- **Web pages:** they run no JavaScript, and a strict Content Security Policy is applied.
- **Canaries:** SHAPI probes provider APIs only with its own accounts, and stores response shapes (status codes, field names and types), never values.

## Reporting a vulnerability

Please report security issues privately through the repository's **Security → Report a vulnerability** page on GitHub, not in a public issue.
