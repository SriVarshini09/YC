# SHAPI advisories

One JSON file per breaking change, named `<id>.json` and validated by `AdvisorySchema` in `packages/core/src/advisory.ts`. The format is open. Each advisory has: provider, endpoint pattern (`{param}` matches one segment, `*` matches within a segment, `**` matches any number of segments), change class, trigger (what in a call site's dependency surface makes it affected), first observed, published notice, effective date, severity, migration note, optional recipe id, sources, and status.

`status: "verified"` means the facts were checked against the provider's own notice or two independent sources. `"unverified"` means secondary reports only. `drafts/` (Milestone 2) will hold machine-generated advisories awaiting review; it is not loaded.
