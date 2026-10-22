# Repository cleanup

What changed: internal planning and research documents moved out of the repository to the maintainers' machines. `.gitignore` now lists their locations (`research/`, `research_notes/`, `reports/`, `docs/PLAN.md`, `docs/private/`) so they cannot be committed again. References to them were removed from the README, two progress notes and the ESLint config. No code changed.

```
pnpm lint
```
