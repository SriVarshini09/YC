# PB-41: From GitHub to the dashboard in one click (execution plan U-01, U-02)

## Why

Nothing on GitHub led to the SHAPI dashboard:

- after installing the App, GitHub left people on its own settings page;
- the SHAPI check, the fix PRs and the Dashboard issue had no link to app.shapi.dev.

## What changes

- **U-01: setup page.** A new **`/setup`** route redirects to `/` when signed in (the dashboard, or the account list) and to `/login` otherwise.
  - The App manifest now takes `setupUrl` and sets `setup_url` and `setup_on_update`.
  - `github:register` fills it from `--callback-url`, so new registrations get it automatically.
  - **The live App needs it set by hand:** GitHub → Settings → Developer settings → GitHub Apps → shapi-by-srivarshini → General → Post installation → Setup URL `https://app.shapi.dev/setup`, with "Redirect on update" ticked.
- **U-02: dashboard links.** `repoPageUrl()` builds the repository's page, `/a/<account>/r/<repository>`, from `SHAPI_PUBLIC_URL`. It's linked from:
  - the SHAPI check run (`details_url`, so GitHub's "Details" button opens it);
  - the footer of every fix PR;
  - the top of the Dashboard issue.

## Verified

- **Tests:**
  - `/setup` redirects to `/login` without a session, and to `/` with one;
  - the manifest carries `setup_url`;
  - the check run's `details_url` points at the repository's page;
  - the PR footer and the Dashboard issue link it, and both stay unchanged without a public URL.
- **Full suite:** typecheck and lint are clean, and the full suite passes.
