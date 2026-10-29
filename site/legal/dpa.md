# Data processing agreement

::: warning Draft
This agreement applies to SHAPI's early access, which is open to everyone now. It has not been reviewed by a lawyer yet and may change before general availability; changes are posted on this page. Last updated October 29, 2026.
:::

This data processing agreement ("DPA") is part of the [terms of service](/legal/terms) between you ("Customer") and SHAPI. It applies when SHAPI processes personal data for you that is protected by the EU GDPR, the UK GDPR or similar data protection laws. If this DPA and the terms conflict, this DPA wins for personal data.

## 1. Roles

You are the **controller** of the personal data in your repositories and GitHub events. SHAPI is your **processor**. SHAPI is the controller of the data it needs to run its own business, such as sign-in sessions, billing records and request logs. The [privacy policy](/legal/privacy) covers that data.

## 2. The processing

| | |
|---|---|
| **Subject matter** | Finding and fixing code that breaks when third-party APIs change |
| **Duration** | While the SHAPI GitHub App is installed on your account |
| **Nature and purpose** | Downloading and analyzing code, running contract tests in a sandbox, storing call-site maps and findings, and opening checks, issues and pull requests |
| **Data subjects** | People who contribute to your repositories, and people whose data appears in your code |
| **Personal data** | GitHub logins; commit authors' names and email addresses and commit messages in webhook payloads; any personal data contained in source files, which are processed only while a job runs and not stored, apart from the diff of each proposed fix |
| **Special categories** | None intended. Don't put special-category data in repositories you connect to SHAPI. |

## 3. SHAPI's obligations

SHAPI will:

1. **Follow your instructions.** Process personal data only to provide the service as described in the terms and your settings, unless the law requires otherwise, in which case SHAPI will tell you first where it's allowed to.
2. **Keep it confidential.** Anyone who processes the data for SHAPI is bound to confidentiality.
3. **Keep it secure.** Apply the measures in the annex below.
4. **Use only listed subprocessors.** You authorize the providers on the [subprocessors](/legal/subprocessors) page. SHAPI gives at least 30 days' notice of a new one on that page, binds each one to data protection terms at least as protective as this DPA, and stays responsible for them. If you object, you can end the agreement by uninstalling before the change takes effect.
5. **Help you.** Assist, as far as it reasonably can, with requests from data subjects, security, breach notifications, data protection impact assessments and consultations with regulators.
6. **Report breaches.** Tell you without undue delay, and within 72 hours, after becoming aware of a personal data breach affecting your data, with the information you need to meet your own obligations.
7. **Delete the data.** When you uninstall the GitHub App, SHAPI deletes your account's data at once. Webhook payloads are deleted 14 days after they're processed. SHAPI keeps nothing longer, except where the law requires it.
8. **Show compliance.** Give you the information you reasonably need to show that this DPA is being followed, and answer reasonable written questions about it. SHAPI doesn't have a third-party audit report such as SOC 2 yet.

## 4. Transfers outside the EU and UK

SHAPI and its subprocessors process data in the United States. Where a transfer needs a safeguard, the parties agree to the EU Standard Contractual Clauses (Commission Decision 2021/914), Module 2 (controller to processor), with the UK Addendum for UK data. For the clauses: the optional docking clause and clause 11's optional language don't apply; clause 9 option 2 (general authorization) applies with the notice period above; the governing law and courts are those of Ireland; and the annexes are filled in by sections 2 and 3 and the annex below.

## 5. Signing

This DPA applies automatically; no signature is needed. If your organization needs a signed copy, email [sri@shapi.dev](mailto:sri@shapi.dev) with the subject "DPA request".

## Annex: security measures

The [security](/security) page describes these in detail.

- **Access to code:** a separate installation token for each job, limited to one repository with read-only contents, expiring within an hour.
- **No stored source:** code is processed in a temporary folder or sandbox and deleted when the job ends. Only the diff of each proposed fix is kept.
- **Sandboxing:** dependency installs and tests run in a fresh Firecracker microVM for each job. The network is limited to package registries during the install, where install scripts run, and switched off before the customer's code or tests run. The VM holds no credentials and is destroyed after the job, within 60 minutes at most.
- **Separation between customers:** row-level security in Postgres keyed to each account, which the application's database role can't bypass.
- **Authentication:** GitHub sign-in. No GitHub user token is kept. Session cookies are signed and HttpOnly, and only their SHA-256 hash is stored. Sessions expire after 8 hours.
- **Integrity:** webhook signatures are verified with HMAC-SHA256. Web pages run no JavaScript and use a strict Content Security Policy.
- **Encryption in transit:** the service is served only over HTTPS, and SHAPI calls GitHub, E2B, Stripe and Anthropic over HTTPS.
- **Least privilege:** the GitHub App asks only for the permissions listed on the [GitHub App](/guide/github-app#permissions) page and can't change workflow files.
- **AI is opt-in:** code goes to Anthropic only for accounts that turn it on.
