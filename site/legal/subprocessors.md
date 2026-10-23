# Subprocessors

::: warning Draft
This list takes effect when the SHAPI GitHub App opens to the public. Last updated October 23, 2026.
:::

These are the service providers that process customer data for the hosted SHAPI GitHub App and web app. The `shapi-cli` tool uses none of them: it runs on your machine.

| Provider | What it does for SHAPI | Customer data it receives | Location |
|---|---|---|---|
| **GitHub** | Delivers webhooks; source of code; where check runs, fix pull requests and dashboard issues are written | Everything SHAPI does in your repositories goes through GitHub's API | United States |
| **Fly.io** | Hosts the web app and worker, and keeps request logs | All data SHAPI processes, while it is processed | United States (Virginia) |
| **Postgres host** | Stores SHAPI's database | Everything SHAPI stores (see the [privacy policy](/legal/privacy)) | United States. Named here before launch. |
| **E2B** | Runs dependency installs and tests in an isolated microVM for each job | A copy of the repository being fixed, for at most 15 minutes. No tokens or SHAPI credentials. | United States |
| **Stripe** | Payments and subscriptions | GitHub account login, SHAPI account id, the paid plan. Stripe collects payment details itself. | United States |
| **Anthropic** | Proposes a fix when no deterministic recipe fits. **Only for accounts that turn it on.** | The affected file, the advisory and the contract test | United States |
| **Sentry** | Error reports, when enabled | Error messages and stack traces, with request and user data removed | United States |

## Changes to this list

New subprocessors are added to this page at least 30 days before they receive customer data, except in an emergency that affects the security or availability of the service. The page's [history](https://github.com/SriVarshini09/YC/commits/main/site/legal/subprocessors.md) is public. To be notified, watch the repository or subscribe to that file's commits. If you object to a new subprocessor, you can stop using SHAPI by uninstalling it before the change takes effect.
