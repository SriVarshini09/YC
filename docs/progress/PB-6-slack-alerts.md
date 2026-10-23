# PB-6 Slack alerts

What exists: an account can paste a Slack **incoming webhook** under Settings in the web app. SHAPI then posts to that channel when a repository gets a **new** affected call site.

**When it fires:**
- After a push scan, and after an advisory fan-out, so a new advisory hitting code SHAPI already mapped also sends an alert.
- "New" means the affected finding (advisory + file + endpoint, ignoring line numbers) wasn't affected in the repository's previous successful scan, or in the same scan before a fan-out re-match. `saveFindings()` returns those, and the alert is sent after the database transaction commits.
- A rescan with the same findings sends nothing.

**The message** (Block Kit, plus a plain `text` fallback):
- "N new affected call sites in owner/repo, after the push of `abc1234`" (or "from a new or updated advisory").
- Up to 10 findings, most severe first. Each one shows the severity, the advisory title linked to its file in `shapi-advisories`, the file and line linked to the exact commit on GitHub, and the deadline with days left. The rest are counted.
- A link to the account page in SHAPI.

**Safety:**
- Only `https://hooks.slack.com/services/…` URLs are accepted, both when saving and again before every send, so the server can't be made to post to any other address.
- A failed post is logged and never fails a scan. Requests time out after 10 seconds.

**Web app:**
- The field shows "connected: webhook ending in XXXXXX". The full link is never shown back.
- Leaving the field empty keeps the current webhook; "Stop Slack alerts" removes it.
- **Send a test message** reports success or failure.

The privacy policy and the GitHub App guide describe the alerts.

Verified:
- A first scan alerts on the demo's 3 findings, and a rescan sends nothing.
- A new advisory alerts only on its own finding.
- The notifier posts only to a valid Slack webhook (no webhook, or an internal address, means no request) and swallows Slack errors.
- The message format is tested: ordering, links, deadline days, and the "…and N more" line.
- The web settings flow is tested: save, reject a non-Slack URL, mask, keep, test message (sent and failed), remove.
- 255 tests pass, plus lint and typecheck.

Email alerts are not built. They need a sending domain.
