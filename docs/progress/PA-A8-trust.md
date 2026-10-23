# PA-A8 trust basics

What exists: four legal pages on the docs site, under a new **Legal** sidebar group. Each is marked as a draft that takes effect when the GitHub App opens to the public, and as not yet reviewed by a lawyer.
- **Privacy policy** (`site/legal/privacy.md`): what the GitHub App, web sign-in, billing, Claude, logs, the CLI and the docs site collect and why; the two cookies; retention; sharing; US processing; rights; contact.
- **Terms of service** (`site/legal/terms.md`): the service and the open licenses, your code, fix PRs as suggestions, acceptable use, plans and payment, termination, no warranty, a liability cap, changes, Delaware law.
- **Data processing agreement** (`site/legal/dpa.md`): roles, the processing table, processor duties, 72-hour breach notice, deletion, SCCs (Module 2) with the UK Addendum, and an annex of security measures.
- **Subprocessors** (`site/legal/subprocessors.md`): GitHub, Fly.io, the Postgres host (to be named), E2B, Stripe, Anthropic (opt-in) and Sentry (when enabled), with what each receives and 30 days' notice of changes.

Decisions, from you: the provider is "the SHAPI project, operated by its founder" until incorporation; requests go through GitHub, with no email published; Delaware law; draft banners.

Facts the pages rest on, checked in the code: the stored tables and their cascades on uninstall, 14-day webhook payloads, 8-hour hashed sessions and the 10-minute sign-in state cookie, what is sent to Stripe (login as the customer name, account id as metadata), Sentry with request and user data removed, Fastify request logs with client IPs, call sites stored without code, and no telemetry in the CLI.

Also changed:
- The web app has a footer linking to the docs, security, privacy and terms pages. The plan card says that upgrading means accepting the terms. Both are covered by tests.
- The docs site's footer links to privacy, terms and security, and the security page links to the privacy policy and subprocessors.

Verified: the site builds with no dead links, the new pages checked in a browser, lint, typecheck and the full test suite pass.

Needs you before launch: a lawyer's review, the company name once you incorporate, a contact email once you have a domain, and the name of the Postgres host.

```
pnpm --filter @shapi/site docs:dev
```
