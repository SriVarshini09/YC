# M2-T6 draft advisory from diff

What exists: `draftAdvisory({ before, after, diff })` in `packages/canary/src/draft.ts` turns a breaking shape change into an advisory: id from provider, endpoint and date; title; summary listing the breaking changes; change class and trigger from the primary change (status-code → the old status codes; field changes → field paths; enum → field; auth and sunset → any call); severity by class; migration note; provider docs as source; `status: "unverified"`; and a new optional `evidence` block in `AdvisorySchema` (before/after times, statuses, shape hashes, every change). `pnpm canary run` and `pnpm canary replay` write drafts to `advisories/drafts/` (`--drafts <dir>`, `--no-drafts`); `advisories/drafts/README.md` explains the review step (check, edit, set status, move up to `advisories/`).
How to run: `pnpm canary replay fixtures/recordings/github-workflow-dispatch-204-to-200.json`, then `npx shapi scan fixtures/demo-ts --advisories advisories/drafts`, which flags `src/deploy.ts:13` from the machine-drafted advisory.
Not done: Milestone 2's "done when" is met for GitHub (live public probes, replay, draft, match). The Stripe probes and the GitHub dispatch probe have not run live: they need a Stripe test key and a SHAPI-owned test repo.
Decisions: a test checks that the replayed draft equals the hand-written seed on provider, endpoint, change class, trigger, severity, dates and notice, and that the Milestone 1 matcher flags the demo fixture with it. Drafts are never loaded by default.

```
pnpm canary replay fixtures/recordings/github-workflow-dispatch-204-to-200.json
npx shapi scan fixtures/demo-ts --advisories advisories/drafts
```
