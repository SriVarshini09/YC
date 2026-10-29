---
description: "The service providers that process customer data for SHAPI's hosted service."
---

# Subprocessors

::: warning Draft
This list applies to SHAPI's early access, which is open to everyone now. Changes are posted on this page. Last updated October 29, 2026.
:::

These are the service providers that process customer data for the hosted SHAPI GitHub App and web app. The `shapi-cli` tool uses none of them: it runs on your machine.

| Provider | What it does for SHAPI | Customer data it receives | Location |
|---|---|---|---|
| **GitHub** | Delivers webhooks; source of code; where check runs, fix pull requests and dashboard issues are written | Everything SHAPI does in your repositories goes through GitHub's API | United States |
| **Fly.io** | Hosts the web app, the worker and this documentation site, and keeps their request logs | All data SHAPI processes, while it is processed | United States (Virginia) |
| **Neon** | Hosts SHAPI's Postgres database | Everything SHAPI stores (see the [privacy policy](/legal/privacy)) | United States |
| **E2B** | Runs dependency installs and tests in an isolated microVM for each job | A copy of the repository being fixed, for at most 60 minutes (usually far less: it is destroyed when the job ends). No tokens or SHAPI credentials. | United States |
| **Stripe** | Payments and subscriptions | GitHub account login, SHAPI account id, the paid plan. Stripe collects payment details itself. | United States |
| **Anthropic** | Proposes a fix when no deterministic recipe fits. **Only for accounts that turn it on.** | The affected file, the advisory, the contract test and its failing output | United States |
| **Sentry** | Error reports, when enabled | Error messages and stack traces, with request and user data removed | United States |

## Changes to this list

New subprocessors are added to this page at least 30 days before they receive customer data, except in an emergency that affects the security or availability of the service. To be notified of changes, email [sri@shapi.dev](mailto:sri@shapi.dev) and ask to be added to the list. If you object to a new subprocessor, you can stop using SHAPI by uninstalling it before the change takes effect.
