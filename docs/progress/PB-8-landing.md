# PB-8 landing page

What exists: the docs site's home page (https://srivarshini09.github.io/YC/) is a landing page with an **Install the GitHub App** button. The button links to `github.com/apps/shapi-by-srivarshini/installations/new`, in the hero and again at the end.

Sections:
- **The problem:** mocked tests keep passing while the real API changes.
- **Live numbers:** researched changes, deadlines ahead, providers, automatic fixes, and the provider list.
- **Upcoming API deadlines:** the next 8, each with days left, the severity, and a link to the advisory in `shapi-advisories`.
- **How it works:** map, match, fix, watch.
- **See it on your code:** `npx shapi-cli scan .` and the demo's real output.
- **What a fix PR looks like.**
- **Pricing:** free for public repositories and one private one; more private repositories cost a monthly price per repository, announced first; free during early access.
- **Security:** a short summary, with links to the security, privacy and subprocessors pages.

**Numbers come from the data, not the text.** `site/.vitepress/advisories.data.ts` is a VitePress build-time loader over `advisories/*.json`, the same set the CLI ships. It feeds the landing page and a new full table on the Advisories page (54 advisories: 49 verified, 11 with an automatic fix). The Docs workflow also builds **daily** (05:17 UTC), so "deadlines ahead" and "in N days" stay current between pushes.

Also:
- **GitHub App guide:** the early-access note no longer says the app is "not open for public installation". Anyone can install it, it's free during early access, and SHAPI asks before charging.
- **Layout:** the step cards go 4 → 2 → 1 columns as the screen narrows.
- **Phone layout:** the deadline table folds the provider into the change column and hides the severity column. The page is exactly 375 px wide on a phone (checked: nothing overflows).

Verified in the browser: desktop in dark mode, phone (375 px) in light mode, the call-to-action buttons, and the Advisories page table (54 rows, no overflow on a phone). The docs build passes with no dead links.

Needs you before launch: publish `shapi-cli` 0.2.0. The landing page says `npx shapi-cli fix . --write` fixes all three demo findings; npm still has 0.1.0, which fixes one.
