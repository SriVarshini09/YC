# Privacy policy

::: warning Draft
This policy takes effect when the SHAPI GitHub App opens to the public. It has not been reviewed by a lawyer yet. Last updated October 23, 2026.
:::

SHAPI is operated by its founder and is not yet incorporated. In this policy, "SHAPI", "we" and "us" mean the SHAPI project and its operator. This policy covers the hosted GitHub App and web app, the `shapi-cli` command-line tool, and this documentation site.

The short version: SHAPI reads your code to find and fix third-party API breakages. It keeps a map of your API call sites and the findings, not your source files. It has no advertising, no analytics and no tracking, and it doesn't sell data.

## What we collect, and why

### The GitHub App

When you install the GitHub App, GitHub sends SHAPI information about the installation and its repositories, and SHAPI reads the code of the repositories you select.

| Data | Why |
|---|---|
| Account: GitHub login, account type (user or organization), installation id, your SHAPI settings | To run the app for your account |
| Repositories: name, default branch, public or private, last scanned commit | To scan the right repositories and enforce plan limits |
| The **api.lock** of each scanned commit: file paths and line numbers of third-party API calls, the endpoints called, and the status codes, fields, enums and headers the code relies on | To show findings and re-check them when an advisory is added |
| Findings: which advisory affects which call site, and why | To show results and open fix pull requests |
| Fix pull request records: branch, number, state | To update PRs in place and apply noise limits |
| GitHub webhook payloads | To process events and retry failures. Payloads are written by GitHub. A `push` payload, for example, includes commit messages and the commit authors' names and email addresses. |

**Source code** is downloaded for each scan or fix, processed in a temporary folder or an isolated sandbox, and deleted when the job ends. SHAPI doesn't keep copies of your source files. See [Security and code handling](/security) for the details.

### Signing in to the web app

When you sign in with GitHub, SHAPI reads your GitHub user id, your login and the GitHub App installations you can access. It stores them in a session that expires after 8 hours. SHAPI keeps no GitHub token for you: it discards the token right after sign-in.

### Billing

Paid plans are handled by Stripe. SHAPI creates a Stripe customer named after your GitHub account login. Stripe collects your payment details, email address and billing address directly, on its own pages. SHAPI never sees your card number. SHAPI stores the Stripe customer and subscription ids, the subscription status, how many private repositories are paid for, and when the current period ends.

### Using Claude (opt-in)

If an account turns on *Use Claude when no deterministic recipe fits*, SHAPI sends the affected file, the advisory and the contract test to Anthropic's API to propose a fix. It's off by default. Under Anthropic's commercial terms, API inputs are not used to train its models.

### Logs and error reports

The web server's request logs record the time, method, URL, response status and the client's IP address. They're kept in the hosting provider's log system, not in SHAPI's database, and are used to run and secure the service. When error reporting is enabled, error reports go to Sentry with request data and user data removed.

### The CLI

`shapi-cli` runs on your machine and sends nothing to SHAPI. It has no telemetry. It contacts GitHub only when you pass `--pr`, and Anthropic only when you pass `--llm`, using your own tokens. npm handles downloads of the package under its own privacy policy.

### This documentation site

This site is hosted on GitHub Pages. GitHub may log visitors' IP addresses under its own privacy statement. The site sets no cookies and has no analytics. Your browser stores your light or dark theme choice locally, and search runs in your browser.

## Cookies

The web app sets two cookies, both needed for sign-in and neither used for tracking:

| Cookie | Purpose | Lifetime |
|---|---|---|
| Session | Keeps you signed in. Signed and HttpOnly. SHAPI stores only a SHA-256 hash of it. | 8 hours |
| Sign-in state | Protects the GitHub sign-in redirect against forgery | 10 minutes |

## How long we keep data

- **Account, repository, scan, findings and fix PR data:** while the GitHub App is installed. Uninstalling deletes it at once.
- **Webhook payloads:** 14 days.
- **Sessions:** 8 hours, or until you sign out.
- **Billing record:** deleted when you uninstall. Stripe keeps its own records as required by law.

## Who we share data with

We share data only with the service providers that run SHAPI. They're listed, with what each one receives, on the [subprocessors](/legal/subprocessors) page. We don't sell personal data or share it for advertising. We may disclose data if the law requires it.

## Where data is processed

SHAPI is hosted in the United States, and its service providers process data mainly in the United States. If you're outside the United States, your data is transferred there. For customers whose data falls under the GDPR or the UK GDPR, the [data processing agreement](/legal/dpa) covers these transfers.

## Your choices and rights

- **Delete everything:** uninstall the GitHub App from your GitHub settings. SHAPI deletes your account and its data at once. Cancel a paid subscription under *Manage billing* first, because uninstalling doesn't cancel it.
- **Stop using Claude:** turn the setting off in the web app.
- **Access, correction, deletion or objection:** depending on where you live, you may have these rights under laws such as the GDPR or the CCPA. Ask for any of them as described below, and we'll respond within 30 days.

## Children

SHAPI is a tool for software developers and isn't directed at children under 16.

## Changes

We'll post changes to this page. The page's history is public in the [repository](https://github.com/SriVarshini09/YC/commits/main/site/legal/privacy.md). Significant changes will be summarized at the top of this page before they take effect.

## Contact

SHAPI doesn't have a privacy email address yet. To make a request, [open an issue](https://github.com/SriVarshini09/YC/issues/new) titled "Privacy request". Don't include personal details in the issue; we'll reply there to arrange a private channel. To report a security problem, use the repository's [private vulnerability reporting](https://github.com/SriVarshini09/YC/security/advisories/new).
