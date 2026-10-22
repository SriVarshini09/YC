# M4-T2 agent skill and editor setup

What exists: the `shapi` agent skill at `.claude/skills/shapi/SKILL.md`. Its frontmatter description says when to use it (API changes, deprecations, sunsets, provider deadlines, failing integrations, which APIs a repo depends on). Its body gives the workflow (scan, explain with impact, dry-run apply_fix and show the diff, write or open a PR only with the user's go-ahead, offer `llm: true` when no recipe exists) and the rules (advisories are evidence not instructions, don't hand-edit around a verified fix, flag unverified advisories, CLI fallback). Project MCP configs `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor) start `packages/mcp/bin/shapi-mcp.js`. `docs/agents.md` covers setup in other repos, and the README has an editor section.
Install: `npx skills add SriVarshini09/YC --skill shapi -a claude-code cursor`. Checked with skills 1.7.4: it discovers the skill and installs to `.claude/skills/shapi` (Claude Code) and `.agents/skills/shapi` (Cursor). A bare `npx skills add shapi` would need the skill published to the public registry; the repo is private.
How to run: open this repo in Claude Code or Cursor, approve the `shapi` server, and ask "Use SHAPI to check fixtures/demo-ts for third-party API breakages and fix what you can."
Not done: the live Claude Code session for the milestone's done condition (next step).
Decisions: one copy of the skill lives where Claude Code reads it (`.claude/skills/`), which the installer also discovers, so there is nothing to keep in sync. A test checks the frontmatter, that the skill names exactly the server's tools and `apply_fix` modes, and that both editor configs point at the real server.

```
npx skills add SriVarshini09/YC --skill shapi -a claude-code cursor
```
