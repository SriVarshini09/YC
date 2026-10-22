# M2-T4 shape diff and classification

What exists: `diffShapes(before, after)` in `packages/shapes/src/diff.ts` returns every difference with an impact (breaking, non-breaking, informational), the advisory change class it maps to, and a one-line detail. Status: a 2xx-to-2xx change is a breaking `status-code` change (the 204 to 200 case); success to 401/403 is `auth`; success to 404/410 is `version-sunset`; 5xx and 429 are informational. Fields, matched by path hash so redacted shapes work: removed is `field-rename` (reported at the top of the removed subtree only), type change is `field-rename`, newly nullable is `required-field`, a new value on an enum-like field is `enum-added`, added fields are non-breaking. Headers: a content-type change is breaking, a new `deprecation`/`sunset` header is a `version-sunset` signal, and other header changes are informational. The canary now attaches the diff to every changed probe and prints it.
How to run: `pnpm test packages/shapes packages/canary`.
Not done: comparing against the whole history (today it compares two observations); severity is assigned when drafting advisories (T2.6).
Decisions: fields are not compared across a success/error boundary, because an error body says nothing about the contract. A field counts as enum-like only once its values repeat (occurrences at least twice the distinct values), so sampling noise (one run sees "success", the next "skipped") is not reported as a new enum member.

```
pnpm test packages/shapes
```
