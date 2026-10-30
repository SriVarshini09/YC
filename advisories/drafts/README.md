# Draft advisories

Machine-drafted advisories land here: the canary (`pnpm canary run`) writes one when a probe's response shape changes in a breaking way, and so does a replay (`pnpm canary replay <recording>`). `pnpm canary models-dev` writes one for every model [models.dev](https://models.dev) marks deprecated on a host SHAPI knows (OpenAI, Anthropic, Gemini). It has no shutdown date, so its `effectiveDate` is the day the model was first seen deprecated, kept across runs. Drafts are `status: "unverified"` and carry an `evidence` block (before and after observation times, status codes, shape hashes, and every change found).

`loadAdvisories` and `shapi scan` skip this folder by default. To see what a draft would flag in a repo, run:

```bash
pnpm exec shapi scan <repo> --advisories advisories/drafts
```

Review: check the evidence against the provider's docs and changelog, fix the title, summary and migration note, add sources, set `status`, then move the file up to `advisories/`.
